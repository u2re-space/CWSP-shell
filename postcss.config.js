import autoprefixer from "autoprefixer";
import cssnano from "cssnano";
import postcssImport from "postcss-import";
import postcssPresetEnv from "postcss-preset-env";

const browsers = ["last 1 chrome version", "last 1 edge version"];

const presetEnvConfig = {
    stage: false,
    autoprefixer: false,
    browsers,
    features: {
        "custom-media-queries": true,
        // Keep light-dark(light, dark) as-is; do not polyfill or collapse to a single value
        "light-dark-function": false,
    },
    preserve: true,
};

const cssnanoConfig = {
    preset: [
        "advanced",
        {
            calc: false,
            layer: false,
            scope: false,
            discardOverridden: false,
            discardEmpty: true,
            discardUnused: true,
            discardDuplicates: true,
            reduceIdents: {
                gridTemplate: false,
            },
            mergeRules: true,
            discardComments: {
                removeAll: true,
            },
            // Avoid invalid color definitions from value collapse/optimization
            colormin: false,
        },
    ],
};

export default {
    plugins: [
        //postcssImport(),
        postcssPresetEnv(presetEnvConfig),
        // Disabled: can collapse property values and produce invalid color definitions
        // removeDuplicateValues({ preserveEmpty: false }),
        cssnano(cssnanoConfig),
    ],
};
