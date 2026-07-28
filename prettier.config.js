/** @type {import('prettier').Config} */
export default {
    trailingComma: "none",
    tabWidth: 4,
    useTabs: false,
    semi: true,
    singleQuote: false,
    printWidth: 480,
    arrowParens: "always",
    endOfLine: "lf",
    bracketSpacing: true,
    bracketSameLine: true,
    singleAttributePerLine: false,
    embeddedLanguageFormatting: "auto",
    proseWrap: "preserve",
    htmlWhitespaceSensitivity: "css",
    overrides: [
        {
            files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs", "**/*.cjs"],
            options: {
                parser: "typescript"
            }
        },
        {
            files: ["**/*.scss", "**/*.css"],
            options: {
                parser: "scss"
            }
        },
        {
            files: ["**/*.json", "**/*.jsonc", "**/*.json5"],
            options: {
                parser: "json",
                printWidth: 1000,
                trailingComma: "none"
            }
        }
    ]
}
