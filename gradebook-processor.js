/**
 * Gradebook Processor for Canvas CSV exports
 * Works in both modern browsers and Node.js environments.
 */

class GradebookProcessor {
  /**
   * Parse a CSV string into a 2D array of strings.
   * Handles escaped quotes, commas inside quotes, and newlines.
   */
  static parseCSV(text) {
    const rows = [];
    let currentRow = [];
    let currentCell = '';
    let inQuotes = false;
    let i = 0;

    // Normalize line endings
    const str = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    while (i < str.length) {
      const char = str[i];

      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < str.length && str[i + 1] === '"') {
            currentCell += '"';
            i++; // skip escaped quote
          } else {
            inQuotes = false;
          }
        } else {
          currentCell += char;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
        } else if (char === ',') {
          currentRow.push(currentCell);
          currentCell = '';
        } else if (char === '\n') {
          currentRow.push(currentCell);
          rows.push(currentRow);
          currentRow = [];
          currentCell = '';
        } else {
          currentCell += char;
        }
      }
      i++;
    }

    if (currentCell.length > 0 || currentRow.length > 0) {
      currentRow.push(currentCell);
      rows.push(currentRow);
    }

    // Filter out trailing empty rows
    while (rows.length > 0 && rows[rows.length - 1].every(cell => cell.trim() === '')) {
      rows.pop();
    }

    return rows;
  }

  /**
   * Convert a 2D array back into an RFC-compliant CSV string.
   */
  static stringifyCSV(rows) {
    return rows.map(row => 
      row.map(cell => {
        const val = cell === null || cell === undefined ? '' : String(cell);
        if (val.includes(',') || val.includes('"') || val.includes('\n')) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      }).join(',')
    ).join('\r\n');
  }

  /**
   * Process Canvas Gradebook CSV data based on a list of calculation rules.
   * 
   * @param {string|Array<Array<string>>} csvData - Raw CSV text or 2D parsed array
   * @param {Array<Object>} rules - Array of calculation rules
   * @returns {{ csvText: string, rows: Array<Array<string>>, headers: Array<string>, logs: Array<string> }}
   */
  static process(csvData, rules = []) {
    const logs = [];
    const rows = typeof csvData === 'string' ? this.parseCSV(csvData) : csvData.map(r => [...r]);

    if (rows.length < 2) {
      throw new Error('CSV must contain at least a header row and a points possible row.');
    }

    const headers = [...rows[0]];
    const pointsPossibleRow = rows[1];
    const isCanvasPointsRow = pointsPossibleRow[0] && pointsPossibleRow[0].toLowerCase().includes('points possible');

    const dataStartRow = isCanvasPointsRow ? 2 : 1;
    logs.push(`Detected ${headers.length} columns and ${rows.length - dataStartRow} student/data rows.`);

    // Helper to find column index (or create it if it doesn't exist)
    function getOrCreateColumnIndex(colName, defaultPointsPossible = '') {
      let idx = headers.indexOf(colName);
      if (idx === -1) {
        // Try finding by matching start if it includes ID suffix pattern
        idx = headers.findIndex(h => h.trim().toLowerCase() === colName.trim().toLowerCase());
      }
      if (idx === -1) {
        idx = headers.length;
        headers.push(colName);
        rows[0].push(colName);
        if (isCanvasPointsRow) {
          rows[1].push(defaultPointsPossible !== undefined ? String(defaultPointsPossible) : '');
        }
        for (let r = dataStartRow; r < rows.length; r++) {
          rows[r].push('');
        }
        logs.push(`Added new target column "${colName}" at index ${idx}.`);
      }
      return idx;
    }

    // Helper to find matching source column indices for a rule
    function matchColumns(rule) {
      const matched = [];
      headers.forEach((header, index) => {
        // Skip metadata columns
        if (['LastName', 'FirstName', 'ID', 'SIS User ID', 'SIS Login ID', 'Section'].includes(header.trim())) {
          return;
        }

        let isMatch = false;
        if (rule.pattern) {
          const reg = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, rule.flags || 'i') : rule.pattern;
          isMatch = reg.test(header);
        } else if (rule.prefix) {
          isMatch = header.toLowerCase().startsWith(rule.prefix.toLowerCase());
        } else if (rule.suffix) {
          isMatch = header.toLowerCase().endsWith(rule.suffix.toLowerCase());
        } else if (rule.columns && Array.isArray(rule.columns)) {
          isMatch = rule.columns.some(col => 
            col === header || header.toLowerCase().startsWith(col.toLowerCase())
          );
        }

        // Don't match the target column itself if it already exists
        if (isMatch && (!rule.targetColumn || header !== rule.targetColumn)) {
          matched.push({
            index,
            header,
            pointsPossible: isCanvasPointsRow ? parseFloat(pointsPossibleRow[index]) || 0 : 0
          });
        }
      });
      return matched;
    }

    // Apply each calculation rule
    for (const rule of rules) {
      if (!rule.targetColumn) {
        logs.push(`Skipping rule with no targetColumn defined.`);
        continue;
      }

      const matchedCols = matchColumns(rule);
      logs.push(`Rule "${rule.name || rule.targetColumn}": Matched ${matchedCols.length} columns.`);

      const targetIndex = getOrCreateColumnIndex(
        rule.targetColumn, 
        rule.pointsPossible !== undefined ? rule.pointsPossible : ''
      );

      if (isCanvasPointsRow && rule.pointsPossible !== undefined) {
        rows[1][targetIndex] = String(rule.pointsPossible);
      }

      for (let r = dataStartRow; r < rows.length; r++) {
        const studentRow = rows[r];
        
        // Skip summary or special non-student rows if necessary (e.g. Test Student if needed, or process all)
        const studentValues = matchedCols.map(col => {
          const raw = studentRow[col.index];
          const val = (raw === '' || raw === undefined || raw === null) ? null : parseFloat(raw);
          return {
            header: col.header,
            value: isNaN(val) ? null : val,
            pointsPossible: col.pointsPossible
          };
        });

        const calculatedValue = GradebookProcessor.evaluateRule(rule, studentValues, studentRow, headers);
        
        if (calculatedValue !== null && calculatedValue !== undefined && !isNaN(calculatedValue)) {
          const decimals = rule.decimals !== undefined ? rule.decimals : 2;
          const formatted = typeof calculatedValue === 'number' 
            ? (decimals >= 0 ? Number(calculatedValue.toFixed(decimals)).toString() : calculatedValue.toString())
            : String(calculatedValue);
          studentRow[targetIndex] = formatted;
        } else if (rule.emptyOnNull) {
          studentRow[targetIndex] = '';
        }
      }
    }

    return {
      csvText: this.stringifyCSV(rows),
      rows,
      headers,
      logs
    };
  }

  /**
   * Evaluate a single calculation rule for a specific student row.
   */
  static evaluateRule(rule, columnData, fullRow, allHeaders) {
    const type = rule.type || 'average';
    // Support "onlyRecorded" (camelCase) or "only-recorded" (hyphenated) or treatEmptyAsZero (boolean)
    const onlyRecorded = rule.onlyRecorded ?? rule['only-recorded'] ?? (rule.treatEmptyAsZero === false);
    const treatNullAsZero = !onlyRecorded;

    // Build active items depending on whether only recorded scores should be included
    let activeItems;
    if (onlyRecorded) {
      activeItems = columnData.filter(item => item.value !== null && item.value !== undefined && !isNaN(item.value));
    } else {
      activeItems = columnData.map(item => ({
        ...item,
        value: (item.value === null || item.value === undefined || isNaN(item.value)) ? 0 : item.value
      }));
    }

    if (activeItems.length === 0 && type !== 'custom') {
      return null;
    }

    switch (type) {
      case 'sum': {
        return activeItems.reduce((acc, curr) => acc + (curr.value || 0), 0);
      }

      case 'average': {
        if (activeItems.length === 0) return null;
        let values = activeItems.map(i => i.value);
        if (rule.dropLowest && rule.dropLowest > 0) {
          values.sort((a, b) => a - b);
          values = values.slice(rule.dropLowest);
        }
        if (values.length === 0) return null;
        const sum = values.reduce((acc, v) => acc + v, 0);
        return sum / values.length;
      }

      case 'percentage': {
        // Total points earned divided by total points possible * 100 for included assignments
        const totalEarned = activeItems.reduce((acc, curr) => acc + (curr.value || 0), 0);
        const totalPossible = activeItems.reduce((acc, curr) => acc + (curr.pointsPossible || 0), 0);
        if (totalPossible === 0) return 0;
        return (totalEarned / totalPossible) * 100;
      }

      case 'count_threshold':
      case 'count_mastered': {
        // Count how many columns meet a score threshold (e.g. >= 8, or >= 9 out of 10)
        const threshold = rule.threshold ?? 8;
        return activeItems.filter(i => i.value !== null && i.value >= threshold).length;
      }

      case 'count_completed': {
        // Count non-empty or non-zero submissions
        const minVal = rule.minVal ?? 0.001;
        return activeItems.filter(i => i.value !== null && i.value >= minVal).length;
      }

      case 'drop_lowest_sum': {
        const dropCount = rule.dropLowest || 1;
        let values = activeItems.map(i => i.value);
        values.sort((a, b) => a - b);
        values = values.slice(dropCount);
        return values.reduce((acc, v) => acc + v, 0);
      }

      case 'weighted_sum': {
        // rule.weights: { columnNameOrPrefix: weight }
        let total = 0;
        activeItems.forEach(item => {
          let weight = 1;
          if (rule.weights) {
            for (const [key, w] of Object.entries(rule.weights)) {
              if (item.header.includes(key)) {
                weight = w;
                break;
              }
            }
          }
          total += (item.value || 0) * weight;
        });
        return total;
      }

      case 'custom': {
        if (typeof rule.formula === 'function') {
          return rule.formula(items, fullRow, allHeaders);
        }
        return null;
      }

      default:
        return null;
    }
  }
}

// Export for Node/CommonJS or attach to global window in browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GradebookProcessor;
} else if (typeof window !== 'undefined') {
  window.GradebookProcessor = GradebookProcessor;
}
