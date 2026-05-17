/// Test-only stub for `monaco-editor`. vitest/vite's resolver
/// trips on the real package's exports map, and no test renders a
/// live editor (the `@monaco-editor/react` <Editor> is mocked
/// per-suite). Export the handful of namespaces type-only code +
/// theme/language registration touch so imports resolve.
export const editor = {
  defineTheme: () => {},
  setTheme: () => {},
  createModel: () => ({ dispose: () => {} }),
};
export const languages = {
  register: () => {},
  setMonarchTokensProvider: () => {},
  setLanguageConfiguration: () => {},
  registerCompletionItemProvider: () => ({ dispose: () => {} }),
  typescript: {
    typescriptDefaults: { addExtraLib: () => {}, setCompilerOptions: () => {} },
    javascriptDefaults: { addExtraLib: () => {}, setCompilerOptions: () => {} },
  },
};
export const Uri = { parse: (s: string) => ({ toString: () => s }) };
export default { editor, languages, Uri };
