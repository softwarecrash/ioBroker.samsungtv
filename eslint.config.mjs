import config from '@iobroker/eslint-config';
import globals from 'globals';

const browserGlobals = {
    ...globals.browser,
    M: 'readonly',
    $: 'readonly',
    sendTo: 'readonly',
    _: 'readonly',
    systemDictionary: 'writable',
};

export default [
    ...config,
    {
        ignores: ['lib/hj/Pairing/Encryption/**'],
    },
    {
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    args: 'none',
                    caughtErrors: 'none',
                    varsIgnorePattern: '^_',
                },
            ],
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
            'jsdoc/no-blank-blocks': 'off',
        },
    },
    {
        files: ['admin/**/*.js'],
        languageOptions: {
            globals: browserGlobals,
        },
    },
    {
        files: ['test/**/*.js', '**/*.test.js'],
        languageOptions: {
            globals: globals.mocha,
        },
    },
];
