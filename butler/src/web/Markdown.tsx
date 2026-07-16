import { lazy, memo, Suspense, type ComponentProps, type MouseEvent } from "react";

import { isProjectArtifactDownloadUrl, parseProjectArtifactPreviewTarget, type ProjectArtifactPreviewTarget } from "./project-artifact-preview";

export function MarkdownImage({ allowRemoteImages, alt, ...rest }: ComponentProps<"img"> & { allowRemoteImages: boolean }) {
  return allowRemoteImages
    ? <img alt={alt ?? ""} {...rest} />
    : <span className="md-image-omitted">{alt ? `Image omitted: ${alt}` : "Remote image omitted"}</span>;
}

export function MarkdownPre({ node: _node, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  return <pre {...props} tabIndex={0} />;
}

const ReactMarkdown = lazy(async () => {
  const [{ default: Markdown }, remarkGfmModule, rehypeHighlightModule] = await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
    import("rehype-highlight")
  ]);
  return {
    default: ({ text, className, allowRemoteImages = true, onProjectArtifactOpen }: {
      text: string;
      className?: string;
      allowRemoteImages?: boolean;
      onProjectArtifactOpen?: (target: ProjectArtifactPreviewTarget) => void;
    }) => (
      <div className={className}>
        <Markdown
          remarkPlugins={[remarkGfmModule.default]}
          rehypePlugins={[[rehypeHighlightModule.default, { detect: true, ignoreMissing: true }]]}
          components={{
          a: ({ children, href, ...rest }) => {
            const target = href ? parseProjectArtifactPreviewTarget(href) : null;
            const isDownload = href ? isProjectArtifactDownloadUrl(href) : false;
            if (target && onProjectArtifactOpen) {
              return (
                <a
                  {...rest}
                  href={href}
                  onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onProjectArtifactOpen(target);
                  }}
                >
                  {children}
                </a>
              );
            }
            if (isDownload) return <a {...rest} href={href} download>{children}</a>;
            return <a {...rest} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
          },
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
          pre: MarkdownPre,
          img: ({ alt, ...rest }) => <MarkdownImage allowRemoteImages={allowRemoteImages} alt={alt ?? ""} {...rest} />
          }}
        >
          {text}
        </Markdown>
      </div>
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
  onProjectArtifactOpen?: (target: ProjectArtifactPreviewTarget) => void;
};

export const Markdown = memo(function Markdown({ text, className, allowRemoteImages, onProjectArtifactOpen }: MarkdownProps) {
  if (!text) {
    return <div className={className} />;
  }
  return (
    <Suspense fallback={<Fallback text={text} className={className} />}>
      <ReactMarkdown text={text} className={className} allowRemoteImages={allowRemoteImages} onProjectArtifactOpen={onProjectArtifactOpen} />
    </Suspense>
  );
});
