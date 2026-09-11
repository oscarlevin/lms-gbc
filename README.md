# The LMS Grade Book Calculator

Dynamically compute additional grade columns for LMS grade books based on custom rules.

Just download your gradebook from your LMS as a CSV file.  Then load this on the site (you aren't loading anything to a server, everything happens locally in your browser).

Then pick a column that you want to compute and use some simple REGEX to select which columns in the CSV file should contribute to those.  You can compute an average, percentage, a total meeting a given threshold, and more.  When you get the rules the way you like, you can save them as a JSON file to load later.

Then process the CSV file (you will see a preview of the new columns).  Download it, and upload it back to your LMS.

Tick **Only calculated columns** next to the download button to leave out every score column your rules didn't calculate.  The student name and ID columns always stay so the LMS can match grades to students, and re-uploading won't touch any other grade.

## Letter grades

Set a rule's calculation to **Letter Grade (Conditions)** to turn columns into letter grades instead of numbers.

A letter grade rule holds an ordered scale.  Each student gets the **first** grade whose conditions they satisfy, so list the highest grade first.  Anyone who matches nothing gets the default grade.

Each grade is earned when **any** group of conditions is satisfied, and **all** of the conditions within a group must hold.  So "an A needs at least 90 on the prep work and at least 22 targets mastered" is one group with two conditions, and a second group is an alternate route to the same grade:

> **A** is earned when *(Prep and Practice ≥ 90 AND Targets Mastered ≥ 22)* OR *(Targets Mastered = 23 AND Prep and Practice ≥ 85)*

Conditions compare a column against a constant with `≥`, `>`, `≤`, `<`, `=`, `≠`, or *between* (inclusive on both ends).  Comparing against text rather than a number does a case-insensitive match, which is handy for conditions on `Section` or on a letter grade column computed by an earlier rule.

A few things worth knowing:

- **Scales collapse.** Click the *Grade Scale* heading to fold a scale you aren't editing — handy once you have a few rules.  The summary line still lists the grades and flags any column it can't find, so nothing hides a problem from you.
- **Rules run in order**, and a rule can only use columns that already exist.  Put the letter grade rule *after* the rules that compute the columns it refers to.  The editor warns about column names it can't find, and the log after processing does too.
- **Column names are matched loosely** — "Prep and Practice Total" will find "Prep and Practice Total (1504450)", so you don't have to paste the LMS id suffix.
- **Blank scores don't satisfy conditions** by default.  Tick **Blank = 0** on the rule to treat an empty cell as a zero instead.
- After processing, the log reports the **grade distribution** so you can sanity-check the cutoffs before downloading.

`math131_letter_grades_example.json` is a complete working example.  Anything you build in the editor saves to JSON like the rest of your rules.

The JSON form of a grade scale looks like this, and hand-written conditions may nest `all` / `any` / `not` as deeply as you like (the editor shows conditions too deeply nested to draw as read-only JSON, but they still apply):

```json
{
  "targetColumn": "Final Letter Grade",
  "type": "letter_grade",
  "defaultGrade": "F",
  "grades": [
    {
      "grade": "A",
      "when": {
        "all": [
          { "column": "Prep and Practice Total", "op": ">=", "value": 90 },
          { "column": "Learning Targets Mastered", "op": ">=", "value": 22 }
        ]
      }
    },
    {
      "grade": "B",
      "when": {
        "any": [
          { "all": [ { "column": "Learning Targets Mastered", "op": ">=", "value": 19 } ] },
          { "all": [ { "column": "Learning Targets Mastered", "op": "between", "value": [16, 18] },
                     { "column": "Final Exam", "op": ">=", "value": 85 } ] }
        ]
      }
    }
  ]
}
```
