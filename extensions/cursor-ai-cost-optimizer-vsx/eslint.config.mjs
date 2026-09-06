// Same posture as the first-party extensions: type-aware lint, promises must be handled, no implicit any.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "dist-bin/**", "node_modules/**", ".vscode-test/**", "resources/**", "test/**", "scripts/**", "eslint.config.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "eqeqeq": ["error", "always"],
    },
  }
);
