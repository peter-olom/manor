import { lazy, memo, Suspense } from "react";

const ReactMarkdown = lazy(async () => {
  const [{ default: Markdown }, remarkGfmModule, rehypeHighlightModule] = await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
    import("rehype-highlight")
  ]);
  return {
    default: ({ text, className }: { text: string; className?: string }) => (
      <Markdown
        className={className}
        remarkPlugins={[remarkGfmModule.default]}
        rehypePlugins={[[rehypeHighlightModule.default, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ children, ...rest }) => (
            <a {...rest} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          )
        }}
      >
        {text}
      </Markdown>
    )
  };
});

const Fallback = memo(function Fallback({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <pre className="md-fallback">{text}</pre>
    </div>
  );
});

type MarkdownProps = {
  text: string;
  className?: string;
};

export const Markdown = memo(function Markdown({ text, className }: MarkdownProps) {
  if (!text) {
    return <div className={className} />;
  }
  return (
    <Suspense fallback={<Fallback text={text} className={className} />}>
      <ReactMarkdown text={text} className={className} />
    </Suspense>
  );
});
