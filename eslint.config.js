/** @type {import('eslint').Linter.Config} */
export default {
    languageOptions: {
        "ecmaVersion": "latest",
        "sourceType": "module"
    },
    linterOptions: {
        "reportUnusedDisableDirectives": true
    },
    rules: {
        semi: ["warn", "always"],
        quotes: ["warn", "double", {"allowTemplateLiterals": true}],
        indent: ["warn", 4, {"SwitchCase": 1, "flatTernaryExpressions": true}],
        braceStyle: ["warn", "1tbs", {"allowSingleLine": true}],
        nonblockStatementBodyPosition: ["warn", "any"],
        curly: ["warn", "all"],
        commaDangle: ["warn", "never"],
        objectCurlySpacing: ["warn", "always"],
        arrayBracketSpacing: ["warn", "never"],
        spaceBeforeBlocks: ["warn", "always"],
        keywordSpacing: ["warn", {"before": true, "after": true}],
        noMixedSpacesAndTabs: ["warn"],
        "arrow-parens": ["warn", "always"],
        "space-unary-ops": ["warn", {"words": true, "nonwords": false}],
        "func-call-spacing": ["warn", "never"],
        "space-in-parens": ["warn", "never"],
        "comma-spacing": ["warn", {"before": false, "after": true}],
        "semi-spacing": ["warn", {"before": false, "after": true}]
    },
    settings: {
        "import/parsers": {
            "@typescript-eslint/parser": {
                "parser": "@typescript-eslint/parser",
                "files": ["**/*.ts", "**/*.tsx"]
            }
        },
        "import/resolver": {
            "typescript": {
                "alwaysTryTypes": true,
                "project": "./tsconfig.json"
            }
        }
    }
}
