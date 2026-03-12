// @ts-strict-ignore
import { parse as csv2json } from 'csv-parse/sync';

import * as fs from '../../../platform/server/fs';
import { logger } from '../../../platform/server/log';
import { looselyParseAmount } from '../../../shared/util';

import { ofx2json } from './ofx2json';
import { qif2json } from './qif2json';
import { xmlCAMT2json } from './xmlcamt2json';

/**
 * Parse OFX amount strings to numbers.
 * Handles various OFX amount formats including currency symbols, parentheses, and multiple decimal places.
 * Returns null for invalid amounts instead of NaN.
 */
function parseOfxAmount(amount: string): number | null {
  if (!amount || typeof amount !== 'string') {
    return null;
  }

  // Handle parentheses for negative amounts (e.g., "(30.00)" -> "-30.00")
  let cleaned = amount.trim();
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = '-' + cleaned.slice(1, -1);
  }

  // Remove currency symbols and other non-numeric characters except decimal point and minus sign
  cleaned = cleaned.replace(/[^\d.-]/g, '');

  // Handle multiple decimal points by keeping only the first one
  const decimalIndex = cleaned.indexOf('.');
  if (decimalIndex !== -1) {
    const beforeDecimal = cleaned.slice(0, decimalIndex);
    const afterDecimal = cleaned.slice(decimalIndex + 1).replace(/\./g, '');
    cleaned = beforeDecimal + '.' + afterDecimal;
  }

  // Ensure we have a valid number format
  if (!cleaned || cleaned === '-' || cleaned === '.') {
    return null;
  }

  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

type StructuredTransaction = {
  amount: number;
  date: string;
  payee_name: string;
  imported_payee: string;
  notes: string;
};

// CSV files return raw data that are not guaranteed to be StructuredTransactions
type CsvTransaction = Record<string, string> | string[];

type Transaction = StructuredTransaction | CsvTransaction;

type ParseError = { message: string; internal: string };
export type ParseFileResult = {
  errors: ParseError[];
  transactions?: Transaction[];
};

export type ParseFileOptions = {
  hasHeaderRow?: boolean;
  delimiter?: string;
  fallbackMissingPayeeToMemo?: boolean;
  skipStartLines?: number;
  skipEndLines?: number;
  importNotes?: boolean;
};

export async function parseFile(
  filepath: string,
  options: ParseFileOptions = {},
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const m = filepath.match(/\.[^.]*$/);

  if (m) {
    const ext = m[0];

    switch (ext.toLowerCase()) {
      case '.qif':
        return parseQIF(filepath, options);
      case '.csv':
      case '.tsv':
        return parseCSV(filepath, options);
      case '.ofx':
      case '.qfx':
        return parseOFXANZ(filepath, options);
      case '.xml':
        return parseCAMT(filepath, options);
      default:
    }
  }

  errors.push({
    message: 'Invalid file type',
    internal: '',
  });
  return { errors, transactions: [] };
}

async function parseCSV(
  filepath: string,
  options: ParseFileOptions,
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  let contents = await fs.readFile(filepath);

  const skipStart = Math.max(0, options.skipStartLines || 0);
  const skipEnd = Math.max(0, options.skipEndLines || 0);

  if (skipStart > 0 || skipEnd > 0) {
    const lines = contents.split(/\r?\n/);

    if (skipStart + skipEnd >= lines.length) {
      errors.push({
        message: 'Cannot skip more lines than exist in the file',
        internal: `Attempted to skip ${skipStart} start + ${skipEnd} end lines from ${lines.length} total lines`,
      });
      return { errors, transactions: [] };
    }

    const startLine = skipStart;
    const endLine = skipEnd > 0 ? lines.length - skipEnd : lines.length;
    contents = lines.slice(startLine, endLine).join('\r\n');
  }

  let data: ReturnType<typeof csv2json>;
  try {
    data = csv2json(contents, {
      columns: options?.hasHeaderRow,
      bom: true,
      delimiter: options?.delimiter || ',',
      // eslint-disable-next-line actual/typography
      quote: '"',
      trim: true,
      relax_column_count: true,
      skip_empty_lines: true,
    });
  } catch (err) {
    errors.push({
      message: 'Failed parsing: ' + err.message,
      internal: err.message,
    });
    return { errors, transactions: [] };
  }

  return { errors, transactions: data };
}

async function parseQIF(
  filepath: string,
  options: ParseFileOptions = {},
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const contents = await fs.readFile(filepath);

  let data: ReturnType<typeof qif2json>;
  try {
    data = qif2json(contents);
  } catch (err) {
    errors.push({
      message: 'Failed parsing: doesn’t look like a valid QIF file.',
      internal: err.stack,
    });
    return { errors, transactions: [] };
  }

  return {
    errors: [],
    transactions: data.transactions
      .map(trans => ({
        amount: trans.amount != null ? looselyParseAmount(trans.amount) : null,
        date: trans.date,
        payee_name: trans.payee,
        imported_payee: trans.payee,
        notes: options.importNotes ? trans.memo || null : null,
      }))
      .filter(trans => trans.date != null && trans.amount != null),
  };
}

async function parseOFX(
  filepath: string,
  options: ParseFileOptions,
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const contents = await fs.readFile(filepath);

  let data: Awaited<ReturnType<typeof ofx2json>>;
  try {
    data = await ofx2json(contents);
  } catch (err) {
    errors.push({
      message: 'Failed importing file',
      internal: err.stack,
    });
    return { errors };
  }

  // Banks don't always implement the OFX standard properly
  // If no payee is available try and fallback to memo
  const useMemoFallback = options.fallbackMissingPayeeToMemo;

  return {
    errors,
    transactions: data.transactions.map(trans => {
      const parsedAmount = parseOfxAmount(trans.amount);
      if (parsedAmount === null) {
        errors.push({
          message: `Invalid amount format: ${trans.amount}`,
          internal: `Failed to parse amount: ${trans.amount}`,
        });
      }

      return {
        amount: parsedAmount || 0,
        imported_id: trans.fitId,
        date: trans.date,
        payee_name: trans.name || (useMemoFallback ? trans.memo : null),
        imported_payee: trans.name || (useMemoFallback ? trans.memo : null),
        notes: options.importNotes ? trans.memo || null : null, //memo used for payee
      };
    }),
  };
}

async function parseCAMT(
  filepath: string,
  options: ParseFileOptions = {},
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const contents = await fs.readFile(filepath);

  let data: Awaited<ReturnType<typeof xmlCAMT2json>>;
  try {
    data = await xmlCAMT2json(contents);
  } catch (err) {
    logger.error(err);
    errors.push({
      message: 'Failed importing file',
      internal: err.stack,
    });
    return { errors };
  }

  return {
    errors,
    transactions: data.map(trans => ({
      ...trans,
      notes: options.importNotes ? trans.notes : null,
    })),
  };
}

/**
 * ANZ-specific copy of parseOFX
 */
async function parseOFXANZ(
  filepath: string,
  options: ParseFileOptions,
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const contents = await fs.readFile(filepath);

  let data: Awaited<ReturnType<typeof ofx2json>>;
  try {
    data = await ofx2json(contents);
  } catch (err) {
    errors.push({
      message: 'Failed importing file',
      internal: err.stack,
    });
    return { errors };
  }

  return processOFXANZ(data);
}

async function processOFXANZ(data: Awaited<ReturnType<typeof ofx2json>>): Promise<ParseFileResult> {
  logger.info('Processing ANZ OFX data');
  const errors = Array<ParseError>();

  const transactions = data.transactions.map(trans => {
    const parsedAmount = parseOfxAmount(trans.amount);
    if (parsedAmount === null) {
      errors.push({
        message: `Invalid amount format: ${trans.amount}`,
        internal: `Failed to parse amount: ${trans.amount}`,
      });
    }

    const name = trans.name?.trim() || null;
    const memo = trans.memo?.trim() || null;
    let payee = name;
    let notes = memo;

    // name is not provided at all for the first 3 types
    // use meno as payee for all 4 types
    if ([
      'Credit Interest Paid',
      'Withholding Tax',
      'Transfer to Term Deposit',
      'Term Deposit Principal',
    ].some(type => memo?.startsWith(type))) {
      payee = memo;
      notes = name;
    }

    const visaTypes = [
      'Visa Purchase',
      'Visa Refund',
    ];
    if (visaTypes.some(type => memo?.startsWith(type))) {
      ({ payee, notes } = processVisaTransaction(trans.fitId, name, memo, visaTypes, errors));
    }

    if (memo?.startsWith('Eft Pos')) {
      ({ payee, notes } = processEftPosTransaction(trans.fitId, name, memo, errors));
    }

    return {
      amount: parsedAmount || 0,
      imported_id: trans.fitId,
      date: trans.date,
      payee_name: payee,
      imported_payee: payee,
      notes,
    };
  });

  return {
    errors,
    transactions,
  };
}

function processVisaTransaction(transactionId: string, name: string, memo: string, visaTypes: readonly string[], errors: ParseError[]) {
  /* Examples:
    <NAME>xxxx **** **** xxxx Df
    <MEMO>Visa Purchase  Pak N Save Q

    <NAME>xxxx **** **** xxxx If
    <MEMO>Visa Purchase  Apple Com Bi

    <NAME>xxxx **** **** xxxx If
    <MEMO>Visa Purchase 0 90 Adobe Sftw A         0 21 FXAmnt=14.94 FXCurr=AUD FXRate=0.90
   */

  const re = new RegExp(`^(${visaTypes.join('|')})\\s+(.*)`);
  const match = memo.match(re);
  if (!match) {
    logger.error('Failed to parse Visa memo', memo);
    errors.push({
      message: `Invalid memo format for Visa transaction ${transactionId}`,
      internal: `Failed to parse memo: ${memo}`,
    });
    return { payee: name, notes: memo };
  }

  const memoType = match[1];
  const memoRest = match[2];
  const dfif = name.slice(-2).toUpperCase();
  const cc = name.slice(0, -2).replaceAll('****', '_').replaceAll(' ', '');

  if (memo.includes('FXAmnt=')) {
    // https://regex101.com/r/sCbSQB/1
    const re = /^(\d+) (\d+)\s+(.*)\s+(\d+) (\d+)\s+(FXAmnt=.*FXRate=\1\.\2)/;
    const match = memoRest.match(re);
    if (!match) {
      logger.error('Failed to parse Visa memo FX details', memo);
      errors.push({
        message: `Invalid memo format for Visa transaction with FX ${transactionId}`,
        internal: `Failed to parse memo: ${memo}`,
      });
      return { payee: name, notes: memo };
    }

    return {
      payee: match[3],
      notes: `${memoType} ${match[6]} FXFee=${match[4]}.${match[5]} #${dfif} #CC${cc}`,
    }
  }

  return {
    payee: memoRest,
    notes: `${memoType} #${dfif} #CC${cc}`,
  }
}

function processEftPosTransaction(transactionId: string, name: string, memo: string, errors: ParseError[]) {
  /* Example:
    <NAME>Merchant
    <MEMO>Eft Pos xxxx******** xxxx   C 241223200344
   */

  const re = /^(Eft Pos)\s+(\d{4})[*]{8} (\d{4})\s+C\s+(.*)/;
  const match = memo.match(re);
  if (!match) {
    logger.error('Failed to parse Eft Pos memo', memo);
    errors.push({
      message: `Invalid memo format for Eft Pos transaction ${transactionId}`,
      internal: `Failed to parse memo: ${memo}`,
    });
    return { payee: name, notes: memo };
  }

  return {
    payee: name,
    notes: `${match[1]} Ref=${match[4]} #CC${match[2]}__${match[3]}`,
  }
}
