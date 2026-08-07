const expoPreset = require('jest-expo/jest-preset');

module.exports = {
  ...expoPreset,
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  resolver: 'react-native-worklets/jest/resolver',
  moduleNameMapper: {
    '^@gorhom/bottom-sheet$': '<rootDir>/node_modules/@gorhom/bottom-sheet/mock.js',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@noble/hashes))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
};
