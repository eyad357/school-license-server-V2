'use strict';

// XLSX / CSV export of the admin records.
//
// Safety rules applied to every text cell:
//   * spreadsheet-formula neutralisation: a text value that would be read as a
//     formula (starts with = + - @ TAB CR, ignoring leading spaces) is prefixed
//     with an apostrophe. Numbers are written as real numbers.
//   * CSV is UTF-8 WITH BOM and CRLF so Arabic opens correctly in Excel.
//   * No secrets are ever exported: only the columns listed below.

const ExcelJS = require('exceljs');

// header (Arabic), key, kind
const COLUMNS = Object.freeze([
  { key: 'customer_number', header: 'رقم العميل', kind: 'int', width: 12 },
  { key: 'customer_name', header: 'اسم العميل', kind: 'text', width: 32 },
  { key: 'license_key', header: 'مفتاح التفعيل', kind: 'text', width: 34 },
  { key: 'product_name', header: 'البرنامج', kind: 'text', width: 26 },
  { key: 'status', header: 'حالة الترخيص', kind: 'text', width: 14 },
  { key: 'max_devices', header: 'الحد الأقصى للأجهزة', kind: 'int', width: 20 },
  { key: 'active_devices', header: 'عدد الأجهزة المستخدمة', kind: 'int', width: 22 },
  { key: 'sale_price', header: 'سعر البيع', kind: 'money', width: 14 },
  { key: 'currency', header: 'العملة', kind: 'text', width: 10 },
  { key: 'license_created_at', header: 'تاريخ إنشاء الترخيص', kind: 'datetime', width: 22 },
  { key: 'sold_at', header: 'تاريخ البيع', kind: 'text', width: 14 },
  { key: 'notes', header: 'الملاحظات', kind: 'text', width: 40 },
]);

const FORMULA_START = /^[\s]*[=+\-@\t\r]/;

function neutralizeFormula(text) {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }

  const d = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(d.getTime())) {
    return '';
  }

  // UTC, fixed format => identical output on every machine.
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Normalised cell value per column kind.
//   returns { text } for strings or { number } for numerics, or {} for empty.
function cellValue(row, column) {
  const raw = row[column.key];

  if (raw === null || raw === undefined || raw === '') {
    return {};
  }

  switch (column.kind) {
    case 'int':
      return { number: Number(raw) };
    case 'money':
      return { number: Number(raw), money: String(raw) };
    case 'datetime':
      return { text: formatDateTime(raw) };
    default:
      return { text: neutralizeFormula(String(raw)) };
  }
}

function csvEscape(text) {
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  const lines = [COLUMNS.map((c) => csvEscape(c.header)).join(',')];

  for (const row of rows) {
    lines.push(
      COLUMNS.map((column) => {
        const cell = cellValue(row, column);

        if (cell.number !== undefined) {
          // Keep the exact stored decimal text for money, plain digits for ints.
          return cell.money !== undefined ? cell.money : String(cell.number);
        }

        return csvEscape(cell.text ?? '');
      }).join(',')
    );
  }

  // BOM + CRLF.
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

async function toXlsx(rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'school-license-server';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('التراخيص', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { horizontal: 'center', vertical: 'middle' };

  for (const row of rows) {
    const added = sheet.addRow({});

    COLUMNS.forEach((column, index) => {
      const cell = added.getCell(index + 1);
      const value = cellValue(row, column);

      if (value.number !== undefined) {
        cell.value = value.number;

        if (column.kind === 'money') {
          cell.numFmt = '#,##0.00';
        }
      } else if (value.text !== undefined) {
        // A plain JS string => stored as a string cell, never as a formula.
        cell.value = value.text;
      }
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function exportFilename(format) {
  const d = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  return `licenses-${d}.${format}`;
}

module.exports = {
  COLUMNS,
  neutralizeFormula,
  toCsv,
  toXlsx,
  exportFilename,
};
