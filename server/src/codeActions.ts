// This file holds code actions derived from diagnostics. There are more code
// actions available in the extension, but they are derived via the analysis
// OCaml binary.
import { match } from "assert";
import * as p from "vscode-languageserver-protocol";

export type filesCodeActions = {
  [key: string]: { range: p.Range; codeAction: p.CodeAction }[];
};

interface findCodeActionsConfig {
  diagnostic: p.Diagnostic;
  diagnosticMessage: string[];
  file: string;
  range: p.Range;
  addFoundActionsHere: filesCodeActions;
}

let wrapRangeInText = (
  range: p.Range,
  wrapStart: string,
  wrapEnd: string
): p.TextEdit[] => {
  // We need to adjust the start of where we replace if this is a single
  // character on a single line.
  let offset =
    range.start.line === range.end.line &&
    range.start.character === range.end.character
      ? 1
      : 0;

  let startRange = {
    start: {
      line: range.start.line,
      character: range.start.character - offset,
    },
    end: {
      line: range.start.line,
      character: range.start.character - offset,
    },
  };

  let endRange = {
    start: {
      line: range.end.line,
      character: range.end.character,
    },
    end: {
      line: range.end.line,
      character: range.end.character,
    },
  };

  return [
    {
      range: startRange,
      newText: wrapStart,
    },
    {
      range: endRange,
      newText: wrapEnd,
    },
  ];
};

let insertBeforeEndingChar = (
  range: p.Range,
  newText: string
): p.TextEdit[] => {
  let beforeEndingChar = {
    line: range.end.line,
    character: range.end.character - 1,
  };

  return [
    {
      range: {
        start: beforeEndingChar,
        end: beforeEndingChar,
      },
      newText,
    },
  ];
};

let removeTrailingComma = (text: string): string => {
  let str = text.trim();
  if (str.endsWith(",")) {
    return str.slice(0, str.length - 1);
  }

  return str;
};

let extractTypename = (lines: string[]): string => {
  let arrFiltered: string[] = [];

  for (let i = 0; i <= lines.length - 1; i += 1) {
    let line = lines[i];
    if (line.includes("(defined as")) {
      let [typeStr, _] = line.split("(defined as");
      arrFiltered.push(removeTrailingComma(typeStr));
      break;
    } else {
      arrFiltered.push(removeTrailingComma(line));
    }
  }

  return arrFiltered.join("").trim();
};

let takeUntil = (array: string[], startsWith: string): string[] => {
  let res: string[] = [];
  let arr = array.slice();

  let matched = false;
  arr.forEach((line) => {
    if (matched) {
      return;
    }

    if (line.startsWith(startsWith)) {
      matched = true;
    } else {
      res.push(line);
    }
  });

  return res;
};

export let findCodeActionsInDiagnosticsMessage = ({
  diagnostic,
  diagnosticMessage,
  file,
  range,
  addFoundActionsHere: codeActions,
}: findCodeActionsConfig) => {
  diagnosticMessage.forEach((line, index, array) => {
    // Because of how actions work, there can only be one per diagnostic. So,
    // halt whenever a code action has been found.
    let codeActionEtractors = [
      simpleTypeMismatches,
      didYouMeanAction,
      addUndefinedRecordFields,
      simpleConversion,
      applyUncurried,
      simpleAddMissingCases,
    ];

    for (let extractCodeAction of codeActionEtractors) {
      let didFindAction = false;

      try {
        didFindAction = extractCodeAction({
          array,
          codeActions,
          diagnostic,
          file,
          index,
          line,
          range,
        });
      } catch (e) {
        console.error(e);
      }

      if (didFindAction) {
        break;
      }
    }
  });
};

interface codeActionExtractorConfig {
  line: string;
  index: number;
  array: string[];
  file: string;
  range: p.Range;
  diagnostic: p.Diagnostic;
  codeActions: filesCodeActions;
}

type codeActionExtractor = (config: codeActionExtractorConfig) => boolean;

// This action extracts hints the compiler emits for misspelled identifiers, and
// offers to replace the misspelled name with the correct name suggested by the
// compiler.
let didYouMeanAction: codeActionExtractor = ({
  codeActions,
  diagnostic,
  file,
  line,
  range,
}) => {
  if (line.startsWith("Hint: Did you mean")) {
    let regex = /Did you mean ([A-Za-z0-9_]*)?/;
    let match = line.match(regex);

    if (match === null) {
      return false;
    }

    let [_, suggestion] = match;

    if (suggestion != null) {
      codeActions[file] = codeActions[file] || [];
      let codeAction: p.CodeAction = {
        title: `Replace with '${suggestion}'`,
        edit: {
          changes: {
            [file]: [{ range, newText: suggestion }],
          },
        },
        diagnostics: [diagnostic],
        kind: p.CodeActionKind.QuickFix,
        isPreferred: true,
      };

      codeActions[file].push({
        range,
        codeAction,
      });

      return true;
    }
  }

  return false;
};

// This action handles when the compiler errors on certain fields of a record
// being undefined. We then offers an action that inserts all of the record
// fields, with an `assert false` dummy value. `assert false` is so applying the
// code action actually compiles.
let addUndefinedRecordFields: codeActionExtractor = ({
  array,
  codeActions,
  diagnostic,
  file,
  index,
  line,
  range,
}) => {
  if (line.startsWith("Some record fields are undefined:")) {
    let recordFieldNames = line
      .trim()
      .split("Some record fields are undefined: ")[1]
      ?.split(" ");

    // This collects the rest of the fields if fields are printed on
    // multiple lines.
    array.slice(index + 1).forEach((line) => {
      recordFieldNames.push(...line.trim().split(" "));
    });

    if (recordFieldNames != null) {
      codeActions[file] = codeActions[file] || [];

      // The formatter outputs trailing commas automatically if the record
      // definition is on multiple lines, and no trailing comma if it's on a
      // single line. We need to adapt to this so we don't accidentally
      // insert an invalid comma.
      let multilineRecordDefinitionBody = range.start.line !== range.end.line;

      // Let's build up the text we're going to insert.
      let newText = "";

      if (multilineRecordDefinitionBody) {
        // If it's a multiline body, we know it looks like this:
        // ```
        // let someRecord = {
        //   atLeastOneExistingField: string,
        // }
        // ```
        // We can figure out the formatting from the range the code action
        // gives us. We'll insert to the direct left of the ending brace.

        // The end char is the closing brace, and it's always going to be 2
        // characters back from the record fields.
        let paddingCharacters = multilineRecordDefinitionBody
          ? range.end.character + 2
          : 0;
        let paddingContentRecordField = Array.from({
          length: paddingCharacters,
        }).join(" ");
        let paddingContentEndBrace = Array.from({
          length: range.end.character,
        }).join(" ");

        recordFieldNames.forEach((fieldName, index) => {
          if (index === 0) {
            // This adds spacing from the ending brace up to the equivalent
            // of the last record field name, needed for the first inserted
            // record field name.
            newText += "  ";
          } else {
            // The rest of the new record field names will start from a new
            // line, so they need left padding all the way to the same level
            // as the rest of the record fields.
            newText += paddingContentRecordField;
          }

          newText += `${fieldName}: assert false,\n`;
        });

        // Let's put the end brace back where it was (we still have it to the direct right of us).
        newText += `${paddingContentEndBrace}`;
      } else {
        // A single line record definition body is a bit easier - we'll just add the new fields on the same line.
        newText += ", ";
        newText += recordFieldNames
          .map((fieldName) => `${fieldName}: assert false`)
          .join(", ");
      }

      let codeAction: p.CodeAction = {
        title: `Add missing record fields`,
        edit: {
          changes: {
            [file]: insertBeforeEndingChar(range, newText),
          },
        },
        diagnostics: [diagnostic],
        kind: p.CodeActionKind.QuickFix,
        isPreferred: true,
      };

      codeActions[file].push({
        range,
        codeAction,
      });

      return true;
    }
  }

  return false;
};

// This action detects suggestions of converting between mismatches in types
// that the compiler tells us about.
let simpleConversion: codeActionExtractor = ({
  line,
  codeActions,
  file,
  range,
  diagnostic,
}) => {
  if (line.startsWith("You can convert ")) {
    let regex = /You can convert (\w*) to (\w*) with ([\w.]*).$/;
    let match = line.match(regex);

    if (match === null) {
      return false;
    }

    let [_, from, to, fn] = match;

    if (from != null && to != null && fn != null) {
      codeActions[file] = codeActions[file] || [];

      let codeAction: p.CodeAction = {
        title: `Convert ${from} to ${to} with ${fn}`,
        edit: {
          changes: {
            [file]: wrapRangeInText(range, `${fn}(`, `)`),
          },
        },
        diagnostics: [diagnostic],
        kind: p.CodeActionKind.QuickFix,
        isPreferred: true,
      };

      codeActions[file].push({
        range,
        codeAction,
      });

      return true;
    }
  }

  return false;
};

// This action will apply a curried function (essentially inserting a dot in the
// correct place).
let applyUncurried: codeActionExtractor = ({
  line,
  codeActions,
  file,
  range,
  diagnostic,
}) => {
  if (
    line.startsWith(
      "This is an uncurried ReScript function. It must be applied with a dot."
    )
  ) {
    const locOfOpenFnParens = {
      line: range.end.line,
      character: range.end.character + 1,
    };

    codeActions[file] = codeActions[file] || [];
    let codeAction: p.CodeAction = {
      title: `Apply uncurried function call with dot`,
      edit: {
        changes: {
          [file]: [
            {
              range: {
                start: locOfOpenFnParens,
                end: locOfOpenFnParens,
              },
              /*
               * Turns `fn(123)` into `fn(. 123)`.
               */
              newText: `. `,
            },
          ],
        },
      },
      diagnostics: [diagnostic],
      kind: p.CodeActionKind.QuickFix,
      isPreferred: true,
    };

    codeActions[file].push({
      range,
      codeAction,
    });

    return true;
  }

  return false;
};

// Untransformed is typically OCaml, and looks like these examples:
//
// `SomeVariantName
//
// SomeVariantWithPayload _
//
// ...and we'll need to transform this into proper ReScript. In the future, the
// compiler itself should of course output real ReScript. But it currently does
// not.
//
// Note that we're trying to not be too clever here, so we'll only try to
// convert the very simplest cases - single variant/polyvariant, with single
// payloads. No records, tuples etc yet. We can add those when the compiler
// outputs them in proper ReScript.
let transformMatchPattern = (matchPattern: string): string | null => {
  if (
    // Parens means tuples or more complicated payloads. Bail.
    matchPattern.includes("(") ||
    // Braces means records. Bail.
    matchPattern.includes("{")
  ) {
    return null;
  }

  let text = matchPattern.replace(/`/g, "#");

  let payloadRegexp = / /g;
  let matched = text.match(payloadRegexp);

  // Constructors are preceded by a single space. Bail if there's more than 1.
  if (matched != null && matched.length > 2) {
    return null;
  }

  // Fix payloads if they can be fixed. If not, bail.
  if (text.includes(" ")) {
    let [variantText, payloadText] = text.split(" ");

    let transformedPayloadText = transformMatchPattern(payloadText);
    if (transformedPayloadText == null) {
      return null;
    }

    text = `${variantText}(${payloadText})`;
  }

  return text;
};

// This action detects missing cases for exhaustive pattern matches, and offers
// to insert dummy branches (using `assert false`) for those branches. Right now
// it works on single variants/polyvariants with and without payloads. In the
// future it could be made to work on anything the compiler tell us about, but
// the compiler needs to emit proper ReScript in the error messages for that to
// work.
let simpleAddMissingCases: codeActionExtractor = ({
  line,
  codeActions,
  file,
  range,
  diagnostic,
  array,
  index,
}) => {
  // Examples:
  //
  // You forgot to handle a possible case here, for example:
  // (AnotherValue|Third|Fourth)
  //
  // You forgot to handle a possible case here, for example:
  // (`AnotherValue|`Third|`Fourth)
  //
  // You forgot to handle a possible case here, for example:
  // `AnotherValue
  //
  // You forgot to handle a possible case here, for example:
  // AnotherValue
  //
  // You forgot to handle a possible case here, for example:
  // (`One _|`Two _|
  // `Three _)

  if (
    line.startsWith("You forgot to handle a possible case here, for example:")
  ) {
    let cases: string[] = [];

    // This collects the rest of the fields if fields are printed on
    // multiple lines.
    let allCasesAsOneLine = array
      .slice(index + 1)
      .join("")
      .trim();

    // Remove leading and ending parens
    allCasesAsOneLine = allCasesAsOneLine.slice(
      1,
      allCasesAsOneLine.length - 1
    );

    // Any parens left means this is a more complex match. Bail.
    if (allCasesAsOneLine.includes("(")) {
      return false;
    }

    let hasMultipleCases = allCasesAsOneLine.includes("|");
    if (hasMultipleCases) {
      cases.push(
        ...(allCasesAsOneLine
          .split("|")
          .map(transformMatchPattern)
          .filter(Boolean) as string[])
      );
    } else {
      let transformed = transformMatchPattern(allCasesAsOneLine);
      if (transformed != null) {
        cases.push(transformed);
      }
    }

    if (cases.length === 0) {
      return false;
    }

    // The end char is the closing brace. In switches, the leading `|` always
    // has the same left padding as the end brace.
    let paddingContentSwitchCase = Array.from({
      length: range.end.character,
    }).join(" ");

    let newText = cases
      .map((variantName, index) => {
        // The first case will automatically be padded because we're inserting
        // it where the end brace is currently located.
        let padding = index === 0 ? "" : paddingContentSwitchCase;
        return `${padding}| ${variantName} => assert false`;
      })
      .join("\n");

    // Let's put the end brace back where it was (we still have it to the direct right of us).
    newText += `\n${paddingContentSwitchCase}`;

    codeActions[file] = codeActions[file] || [];
    let codeAction: p.CodeAction = {
      title: `Insert missing cases`,
      edit: {
        changes: {
          [file]: insertBeforeEndingChar(range, newText),
        },
      },
      diagnostics: [diagnostic],
      kind: p.CodeActionKind.QuickFix,
      isPreferred: true,
    };

    codeActions[file].push({
      range,
      codeAction,
    });

    return true;
  }

  return false;
};

// This detects concrete variables or values put in a position which expects an
// optional of that same type, and offers to wrap the value/variable in
// `Some()`.
let simpleTypeMismatches: codeActionExtractor = ({
  line,
  codeActions,
  file,
  range,
  diagnostic,
  array,
  index,
}) => {
  // Examples:
  //
  // 46 │ let as_ = {
  // 47 │   someProp: "123",
  // 48 │   another: "123",
  // 49 │ }
  // 50 │
  // This has type: string
  // Somewhere wanted: option<string>
  //
  // ...but types etc can also be on multilines, so we need a good
  // amount of cleanup.

  let lookFor = "This has type:";

  if (line.startsWith(lookFor)) {
    let thisHasTypeArr = takeUntil(
      [line.slice(lookFor.length), ...array.slice(index + 1)],
      "Somewhere wanted:"
    );
    let somewhereWantedArr = array
      .slice(index + thisHasTypeArr.length)
      .map((line) => line.replace("Somewhere wanted:", ""));

    let thisHasType = extractTypename(thisHasTypeArr);
    let somewhereWanted = extractTypename(somewhereWantedArr);

    // Switching over an option
    if (thisHasType === `option<${somewhereWanted}>`) {
      codeActions[file] = codeActions[file] || [];

      // We can figure out default values for primitives etc.
      let defaultValue = "assert false";

      switch (somewhereWanted) {
        case "string": {
          defaultValue = `"-"`;
          break;
        }
        case "bool": {
          defaultValue = `false`;
          break;
        }
        case "int": {
          defaultValue = `-1`;
          break;
        }
        case "float": {
          defaultValue = `-1.`;
          break;
        }
      }

      let codeAction: p.CodeAction = {
        title: `Unwrap optional value`,
        edit: {
          changes: {
            [file]: wrapRangeInText(
              range,
              "switch ",
              ` { | None => ${defaultValue} | Some(v) => v }`
            ),
          },
        },
        diagnostics: [diagnostic],
        kind: p.CodeActionKind.QuickFix,
        isPreferred: true,
      };

      codeActions[file].push({
        range,
        codeAction,
      });

      return true;
    }

    // Wrapping a non-optional in Some
    if (`option<${thisHasType}>` === somewhereWanted) {
      codeActions[file] = codeActions[file] || [];

      let codeAction: p.CodeAction = {
        title: `Wrap value in Some`,
        edit: {
          changes: {
            [file]: wrapRangeInText(range, "Some(", ")"),
          },
        },
        diagnostics: [diagnostic],
        kind: p.CodeActionKind.QuickFix,
        isPreferred: true,
      };

      codeActions[file].push({
        range,
        codeAction,
      });

      return true;
    }
  }

  return false;
};
