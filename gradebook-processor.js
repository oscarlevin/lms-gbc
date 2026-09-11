/**
 * Gradebook Processor for Canvas CSV exports
 * Works in both modern browsers and Node.js environments.
 */

// Columns that identify a student rather than hold a score. The LMS needs these
// to line uploaded grades up with the right students.
const IDENTITY_COLUMNS = ['Student', 'LastName', 'FirstName', 'ID', 'SIS User ID', 'SIS Login ID', 'Integration ID', 'Section'];

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

  static isIdentityColumn(header) {
    const name = String(header).trim().toLowerCase();
    return IDENTITY_COLUMNS.some(col => col.toLowerCase() === name);
  }

  /**
   * Reduce processed rows to the identity columns plus the columns rules
   * calculated, so re-uploading the file leaves every other grade untouched.
   */
  static keepCalculatedColumns(rows, calculatedIndices) {
    const keep = new Set(calculatedIndices);
    rows[0].forEach((header, index) => {
      if (this.isIdentityColumn(header)) keep.add(index);
    });
    return rows.map(row => row.filter((_, index) => keep.has(index)));
  }

  /**
   * Process Canvas Gradebook CSV data based on a list of calculation rules.
   * 
   * @param {string|Array<Array<string>>} csvData - Raw CSV text or 2D parsed array
   * @param {Array<Object>} rules - Array of calculation rules
   * @returns {{ csvText: string, rows: Array<Array<string>>, headers: Array<string>, calculatedIndices: Array<number>, logs: Array<string> }}
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
        if (GradebookProcessor.isIdentityColumn(header)) {
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

    // Indices of every column a rule wrote to, whether new or overwritten
    const calculatedIndices = new Set();

    // Apply each calculation rule
    for (const rule of rules) {
      if (!rule.targetColumn) {
        logs.push(`Skipping rule with no targetColumn defined.`);
        continue;
      }

      const matchedCols = matchColumns(rule);
      if (rule.type === 'letter_grade') {
        // Letter grade rules name their columns in conditions rather than matching a pattern.
        const levelCount = (rule.grades || rule.scale || []).length;
        logs.push(`Rule "${rule.name || rule.targetColumn}": Letter grade scale with ${levelCount} grade level(s).`);
      } else {
        logs.push(`Rule "${rule.name || rule.targetColumn}": Matched ${matchedCols.length} columns.`);
      }

      const targetIndex = getOrCreateColumnIndex(
        rule.targetColumn, 
        rule.pointsPossible !== undefined ? rule.pointsPossible : ''
      );

      calculatedIndices.add(targetIndex);

      if (isCanvasPointsRow && rule.pointsPossible !== undefined) {
        rows[1][targetIndex] = String(rule.pointsPossible);
      }

      // Context shared across all rows of this rule (collects warnings/tallies)
      const ruleCtx = { missingColumns: new Set(), distribution: new Map() };

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

        const calculatedValue = GradebookProcessor.evaluateRule(rule, studentValues, studentRow, headers, ruleCtx);

        // Text results (e.g. letter grades) are written through as-is; numbers are rounded.
        const isTextResult = typeof calculatedValue === 'string';
        const isUsable = calculatedValue !== null && calculatedValue !== undefined &&
                         (isTextResult || !isNaN(calculatedValue));

        if (isUsable) {
          const decimals = rule.decimals !== undefined ? rule.decimals : 2;
          const formatted = typeof calculatedValue === 'number' 
            ? (decimals >= 0 ? Number(calculatedValue.toFixed(decimals)).toString() : calculatedValue.toString())
            : String(calculatedValue);
          studentRow[targetIndex] = formatted;
          if (isTextResult) {
            ruleCtx.distribution.set(formatted, (ruleCtx.distribution.get(formatted) || 0) + 1);
          }
        } else if (rule.emptyOnNull) {
          studentRow[targetIndex] = '';
        }
      }

      if (ruleCtx.missingColumns.size > 0) {
        logs.push(
          `Rule "${rule.name || rule.targetColumn}": WARNING - column(s) not found: ` +
          `${Array.from(ruleCtx.missingColumns).join(', ')}. Conditions using them were treated as false. ` +
          `Rules run in order, so a computed column must be produced by an earlier rule.`
        );
      }

      if (ruleCtx.distribution.size > 0) {
        const summary = Array.from(ruleCtx.distribution.entries())
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
          .map(([grade, count]) => `${grade === '' ? '(blank)' : grade} = ${count}`)
          .join(', ');
        logs.push(`Distribution for "${rule.targetColumn}": ${summary}`);
      }
    }

    return {
      csvText: this.stringifyCSV(rows),
      rows,
      headers,
      calculatedIndices: [...calculatedIndices],
      logs
    };
  }

  /**
   * Find the index of a column by name, tolerating the ID suffixes and casing
   * differences common in LMS exports ("Homework Total" matches
   * "Homework Total (1504451)"). Returns -1 when nothing matches.
   */
  static resolveColumnIndex(allHeaders, name) {
    if (!name || !Array.isArray(allHeaders)) return -1;
    const target = String(name).trim();
    if (!target) return -1;

    let idx = allHeaders.indexOf(target);
    if (idx !== -1) return idx;

    const lower = target.toLowerCase();
    idx = allHeaders.findIndex(h => String(h).trim().toLowerCase() === lower);
    if (idx !== -1) return idx;

    idx = allHeaders.findIndex(h => String(h).trim().toLowerCase().startsWith(lower));
    if (idx !== -1) return idx;

    return allHeaders.findIndex(h => String(h).toLowerCase().includes(lower));
  }

  /**
   * Evaluate one leaf condition, e.g. { column: "Exam 1", op: ">=", value: 90 }.
   *
   * Operators: >= > <= < == != between (inclusive), plus the aliases
   * gte/gt/lte/lt/eq/ne. "between" takes value: [min, max], or min/max keys.
   * == and != fall back to case-insensitive text comparison when a non-numeric
   * value is expected, so Section == "001" and Grade == "A" both work.
   */
  static evaluateComparison(node, fullRow, allHeaders, options = {}, ctx = null) {
    const index = this.resolveColumnIndex(allHeaders, node.column);
    if (index === -1) {
      if (ctx && ctx.missingColumns) ctx.missingColumns.add(String(node.column));
      return false;
    }

    const raw = fullRow[index];
    const text = (raw === undefined || raw === null) ? '' : String(raw).trim();
    const numeric = text === '' ? NaN : parseFloat(text);
    const hasNumber = !isNaN(numeric);

    const hasRange = node.min !== undefined || node.max !== undefined;
    const rawOp = node.op ?? node.operator ?? (hasRange ? 'between' : '>=');
    const op = String(rawOp).trim().toLowerCase();

    const expected = node.value ?? node.threshold;
    const isNegated = (op === '!=' || op === 'ne' || op === '!==');
    const isEquality = isNegated || (op === '==' || op === '=' || op === 'eq' || op === '===');

    // Text equality: used whenever the expected value is non-numeric text.
    if (isEquality && typeof expected === 'string' && isNaN(parseFloat(expected))) {
      const matches = text.toLowerCase() === expected.trim().toLowerCase();
      return isNegated ? !matches : matches;
    }

    // Numeric comparison. A blank or non-numeric cell fails the condition unless
    // the rule opts into treating missing scores as zero.
    let value;
    if (hasNumber) {
      value = numeric;
    } else if (options.treatMissingAsZero) {
      value = 0;
    } else {
      return false;
    }

    if (op === 'between' || op === 'in_range' || op === 'range') {
      let min = node.min;
      let max = node.max;
      if (Array.isArray(expected)) {
        min = min ?? expected[0];
        max = max ?? expected[1];
      }
      const lo = parseFloat(min);
      const hi = parseFloat(max);
      if (isNaN(lo) || isNaN(hi)) return false;
      return value >= Math.min(lo, hi) && value <= Math.max(lo, hi);
    }

    const target = parseFloat(expected);
    if (isNaN(target)) return false;

    switch (op) {
      case '>=': case 'gte': return value >= target;
      case '>':  case 'gt':  return value > target;
      case '<=': case 'lte': return value <= target;
      case '<':  case 'lt':  return value < target;
      case '==': case '=': case 'eq': case '===': return value === target;
      case '!=': case 'ne': case '!==': return value !== target;
      default: return false;
    }
  }

  /**
   * Evaluate a boolean condition tree against one student row.
   *
   * A node is one of:
   *   { all: [...] } or { and: [...] }  every child must hold
   *   { any: [...] } or { or:  [...] }  at least one child must hold
   *   { not: node }                     negation
   *   { column, op, value }             a leaf comparison
   *   an array                          shorthand for { all: [...] }
   *
   * A missing or empty condition means "no restriction" and evaluates to true,
   * which lets a trailing grade level act as a catch-all.
   */
  static evaluateCondition(node, fullRow, allHeaders, options = {}, ctx = null) {
    if (node === null || node === undefined) return true;
    if (typeof node === 'boolean') return node;

    if (Array.isArray(node)) {
      if (node.length === 0) return true;
      return node.every(child => this.evaluateCondition(child, fullRow, allHeaders, options, ctx));
    }

    if (typeof node !== 'object') return false;

    const allList = node.all ?? node.and;
    if (Array.isArray(allList)) {
      if (allList.length === 0) return true;
      return allList.every(child => this.evaluateCondition(child, fullRow, allHeaders, options, ctx));
    }

    const anyList = node.any ?? node.or;
    if (Array.isArray(anyList)) {
      if (anyList.length === 0) return true;
      return anyList.some(child => this.evaluateCondition(child, fullRow, allHeaders, options, ctx));
    }

    if (node.not !== undefined) {
      return !this.evaluateCondition(node.not, fullRow, allHeaders, options, ctx);
    }

    // Anything carrying comparison keys is a leaf. An incomplete one (no column
    // name) can never be satisfied, so it must not fall through to "true".
    const leafKeys = ['column', 'op', 'operator', 'value', 'threshold', 'min', 'max'];
    if (leafKeys.some(key => node[key] !== undefined)) {
      if (!node.column || !String(node.column).trim()) return false;
      return this.evaluateComparison(node, fullRow, allHeaders, options, ctx);
    }

    // Only a genuinely empty condition object places no restriction on the student.
    return true;
  }

  /**
   * Evaluate a single calculation rule for a specific student row.
   *
   * @param {Object} ctx - Optional per-rule context used to collect warnings
   *                       (e.g. condition columns that could not be resolved).
   */
  static evaluateRule(rule, columnData, fullRow, allHeaders, ctx = null) {
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

    // Letter grade rules read named columns straight off the row, so they do not
    // need any regex-matched source columns.
    if (activeItems.length === 0 && type !== 'custom' && type !== 'letter_grade') {
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

      case 'letter_grade': {
        // Walk the grade scale top to bottom and return the first grade whose
        // condition the student satisfies. Order matters: highest grade first.
        const scale = rule.grades || rule.scale || [];
        const options = { treatMissingAsZero: rule.treatMissingAsZero === true };

        for (const level of scale) {
          if (!level) continue;
          const condition = level.when ?? level.condition ?? level.conditions ?? null;
          if (GradebookProcessor.evaluateCondition(condition, fullRow, allHeaders, options, ctx)) {
            return String(level.grade ?? level.label ?? '');
          }
        }

        const fallback = rule.defaultGrade ?? rule.default;
        return (fallback === undefined || fallback === null) ? null : String(fallback);
      }

      case 'custom': {
        if (typeof rule.formula === 'function') {
          return rule.formula(columnData, fullRow, allHeaders);
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
