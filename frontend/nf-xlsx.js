/* Niche Finder — minimal, dependency-free .xlsx writer.
   NF_XLSX.download(filename, [{ name, rows }]) writes a real OOXML workbook.
   Rows are arrays of cells: numbers stay numeric (summable in Excel), everything
   else is written as inline text. Produces a valid STORED (uncompressed) zip, so
   no external spreadsheet library is required. */
(function () {
  'use strict';

  var CRC = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function bytes(s) { return new TextEncoder().encode(s); }
  function xesc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function colName(n) { var s = ''; n++; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

  function sheetXml(rows) {
    var body = (rows || []).map(function (row, r) {
      var cells = (row || []).map(function (cell, c) {
        var ref = colName(c) + (r + 1);
        if (typeof cell === 'number' && isFinite(cell)) return '<c r="' + ref + '"><v>' + cell + '</v></c>';
        return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xesc(cell == null ? '' : cell) + '</t></is></c>';
      }).join('');
      return '<row r="' + (r + 1) + '">' + cells + '</row>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + body + '</sheetData></worksheet>';
  }

  function buildFiles(sheets) {
    var files = [];
    files.push(['[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
      '</Types>']);
    files.push(['_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>']);
    files.push(['xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map(function (s, i) { return '<sheet name="' + xesc(String(s.name || ('Sheet' + (i + 1))).slice(0, 31)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
      '</sheets></workbook>']);
    files.push(['xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '</Relationships>']);
    sheets.forEach(function (s, i) { files.push(['xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s.rows)]); });
    return files;
  }

  function zip(files) {
    var parts = [], central = [], offset = 0, count = files.length;
    files.forEach(function (f) {
      var nameB = bytes(f[0]), dataB = bytes(f[1]), crc = crc32(dataB), here = offset;
      var local = new Uint8Array(30 + nameB.length), dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, dataB.length, true); dv.setUint32(22, dataB.length, true);
      dv.setUint16(26, nameB.length, true);
      local.set(nameB, 30);
      parts.push(local, dataB);
      var cen = new Uint8Array(46 + nameB.length), cd = new DataView(cen.buffer);
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
      cd.setUint32(16, crc, true); cd.setUint32(20, dataB.length, true); cd.setUint32(24, dataB.length, true);
      cd.setUint16(28, nameB.length, true); cd.setUint32(42, here, true);
      cen.set(nameB, 46);
      central.push(cen);
      offset += local.length + dataB.length;
    });
    var centralSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new Uint8Array(22), ed = new DataView(end.buffer);
    ed.setUint32(0, 0x06054b50, true); ed.setUint16(8, count, true); ed.setUint16(10, count, true);
    ed.setUint32(12, centralSize, true); ed.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function download(filename, sheets) {
    var blob = zip(buildFiles(sheets));
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  window.NF_XLSX = { download: download };
})();
