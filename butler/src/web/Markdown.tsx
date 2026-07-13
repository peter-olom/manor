import { lazy, memo, Suspense, type ComponentProps } from "react";

export function MarkdownImage({ allowRemoteImages, alt, ...rest }: ComponentProps<"img"> & { allowRemoteImages: boolean }) {
  return allowRemoteImages
    ? <img alt={alt ?? ""} {...rest} />
    : <span className="md-image-omitted">{alt ? `Image omitted: ${alt}` : "Remote image omitted"}</span>;
}

const ReactMarkdown = lazy(async () => {
  const [{ default: Markdown }, remarkGfmModule, rehypeHighlightModule] = await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
    import("rehype-highlight")
  ]);
  return {
    default: ({ text, className, allowRemoteImages = true }: { text: string; className?: string; allowRemoteImages?: boolean }) => (
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
          ),
          img: ({ alt, ...rest }) => <MarkdownImage allowRemoteImages={allowRemoteImages} alt={alt ?? ""} {...rest} />
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
  allowRemoteImages?: boolean;
};

export const Markdown = memo(function Markdown({ text, className, allowRemoteImages }: MarkdownProps) {
  if (!text) {
    return <div className={className} />;
  }
  return (
    <Suspense fallback={<Fallback text={text} className={className} />}>
      <ReactMarkdown text={text} className={className} allowRemoteImages={allowRemoteImages} />
    </Suspense>
  );
});
