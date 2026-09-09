# The LMS Grade Book Calculator

Dynamically compute additional grade columns for LMS grade books based on custom rules.

Just download your gradebook from your LMS as a CSV file.  Then load this on the site (you aren't loading anything to a server, everything happens locally in your browser).

Then pick a column that you want to compute and use some simple REGEX to select which columns in the CSV file should contribute to those.  You can compute an average, percentage, a total meeting a given threshold, and more.  When you get the rules the way you like, you can save them as a JSON file to load later.

Then process the CSV file (you will see a preview of the new columns).  Download it, and upload it back to your LMS.
