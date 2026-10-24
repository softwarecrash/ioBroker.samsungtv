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
        ignores: [
            'admin/build/**',
            'admin/custom/**',
            'build/**',
            'src/lib/hj/Pairing/Encryption/**',
            'src-admin/build/**',
            'src-admin/node_modules/**',
            'src-admin/vite.config.ts',
        ],
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
        files: ['test/**/*.js', '**/*.test.js', '**/*.test.ts'],
        languageOptions: {
            globals: globals.mocha,
        },
    },
];
