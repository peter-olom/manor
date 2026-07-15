export function ManorVersion({ version }: { version: string }) {
  return <span className="brand-version" title={`Manor version ${version}`}>v{version}</span>;
}
