import { isValidElement, memo, useEffect, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { probeResourceAvailability, triggerResourceDownload } from "./api";
import type { PreviewMedia } from "./types";
import { extractCodeLanguage, flattenNodeText } from "./utils";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_REHYPE_PLUGINS = [rehypeHighlight];

type MarkdownMessageProps = {
  text: string;
  onPreviewMedia?: (media: PreviewMedia) => void;
  onResourceUnavailable?: (message: string) => void;
};

function normalizeMessageResourceUrl(rawUrl: string | null | undefined): string | null {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim().replace(/^`+|`+$/g, "") : "";
  if (!trimmed) {
    return null;
  }

  try {
    const baseOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const parsed = trimmed.startsWith("/") ? new URL(trimmed, baseOrigin) : new URL(trimmed);

    if (parsed.hostname === "butler" && parsed.port === "8080") {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }

    if (typeof window !== "undefined" && parsed.origin === window.location.origin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }

    return parsed.toString();
  } catch {
    return trimmed.startsWith("/") ? trimmed : null;
  }
}

function describeMessageResource(rawUrl: string | null | undefined): {
  href: string;
  displayText: string;
  download: boolean;
  previewKind: "image" | "video" | null;
  name: string;
} | null {
  const normalizedUrl = normalizeMessageResourceUrl(rawUrl);
  if (!normalizedUrl) {
    return null;
  }

  try {
    const baseOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const parsed = normalizedUrl.startsWith("/") ? new URL(normalizedUrl, baseOrigin) : new URL(normalizedUrl);
    const pathname = parsed.pathname.toLowerCase();
    const isArtifact = pathname.startsWith("/api/artifacts/");
    const isPreview = pathname.startsWith("/preview/");

    if (!isArtifact && !isPreview) {
      return null;
    }

    let displayText = "Open file";
    let download = false;
    let previewKind: "image" | "video" | null = null;

    if (isPreview) {
      displayText = "Open preview";
    } else if (/\.(png|jpe?g|webp|gif)$/i.test(pathname)) {
      displayText = "Open screenshot";
      previewKind = "image";
    } else if (/\.(webm|mp4|mov)$/i.test(pathname)) {
      displayText = "Open video";
      previewKind = "video";
    } else if (pathname.endsWith(".zip")) {
      displayText = "Download trace";
      download = true;
    } else if (pathname.endsWith(".json")) {
      displayText = "Download manifest";
      download = true;
    } else if (pathname.endsWith(".html")) {
      displayText = "Download HTML";
      download = true;
    } else if (isArtifact) {
      displayText = "Download file";
      download = true;
    }

    if (download && isArtifact && !parsed.searchParams.has("download")) {
      parsed.searchParams.set("download", "1");
    }

    const href =
      normalizedUrl.startsWith("/") || parsed.hostname === "butler"
        ? `${parsed.pathname}${parsed.search}${parsed.hash}`
        : parsed.toString();

    const fileName = parsed.pathname.split("/").filter(Boolean).at(-1) || displayText;
    return { href, displayText, download, previewKind, name: fileName };
  } catch {
    return null;
  }
}

function MarkdownMessageInner({
  text,
  onPreviewMedia,
  onResourceUnavailable
}: MarkdownMessageProps) {
  const previewMediaRef = useRef(onPreviewMedia);
  const resourceUnavailableRef = useRef(onResourceUnavailable);

  useEffect(() => {
    previewMediaRef.current = onPreviewMedia;
    resourceUnavailableRef.current = onResourceUnavailable;
  }, [onPreviewMedia, onResourceUnavailable]);

  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      components={{
        a({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
          const resource = describeMessageResource(typeof href === "string" ? href : null);
          return (
            <a
              href={resource?.href ?? href}
              target={resource?.download ? undefined : "_blank"}
              rel={resource?.download ? undefined : "noreferrer"}
              download={resource?.download ? "" : undefined}
              onClick={
                resource
                  ? (event) => {
                      event.preventDefault();
                      void (async () => {
                        if (resource.previewKind && previewMediaRef.current) {
                          const availability = await probeResourceAvailability(resource.href);
                          if (!availability.ok) {
                            resourceUnavailableRef.current?.(availability.message || "The proof file could not be opened.");
                            return;
                          }

                          previewMediaRef.current({
                            name: resource.name,
                            url: resource.href,
                            kind: resource.previewKind,
                            downloadUrl: resource.href
                          });
                          return;
                        }

                        if (resource.download) {
                          try {
                            await triggerResourceDownload(resource.href);
                          } catch (error) {
                            resourceUnavailableRef.current?.(error instanceof Error ? error.message : "The file could not be downloaded.");
                          }
                        }
                      })();
                    }
                  : undefined
              }
              {...props}
            >
              {children}
            </a>
          );
        },
        pre({ children }) {
          const language = extractCodeLanguage(children);
          return (
            <div className="code-block-shell">
              <div className="code-block-bar">
                <span>{language || "text"}</span>
              </div>
              <pre className="code-block-pre">{children}</pre>
            </div>
          );
        },
        code({ children, className, ...props }: ComponentPropsWithoutRef<"code">) {
          const isBlock = typeof className === "string" && className.includes("language-");
          if (isBlock) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }

          const inlineText = flattenNodeText(children as ReactNode).trim();
          const resource = describeMessageResource(inlineText);
          if (resource) {
            return (
              <a
                className="inline-code inline-code-link"
                href={resource.href}
                target={resource.download || resource.previewKind ? undefined : "_blank"}
                rel={resource.download || resource.previewKind ? undefined : "noreferrer"}
                download={resource.download ? "" : undefined}
                onClick={
                  resource.download || resource.previewKind
                    ? (event) => {
                        event.preventDefault();
                        void (async () => {
                          if (resource.previewKind && previewMediaRef.current) {
                            const availability = await probeResourceAvailability(resource.href);
                            if (!availability.ok) {
                              resourceUnavailableRef.current?.(availability.message || "The proof file could not be opened.");
                              return;
                            }

                            previewMediaRef.current({
                              name: resource.name,
                              url: resource.href,
                              kind: resource.previewKind,
                              downloadUrl: resource.href
                            });
                            return;
                          }

                          if (resource.download) {
                            try {
                              await triggerResourceDownload(resource.href);
                            } catch (error) {
                              resourceUnavailableRef.current?.(error instanceof Error ? error.message : "The file could not be downloaded.");
                            }
                          }
                        })();
                      }
                    : undefined
                }
              >
                {resource.displayText}
              </a>
            );
          }

          return (
            <code className="inline-code" {...props}>
              {children}
            </code>
          );
        }
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export const MarkdownMessage = memo(MarkdownMessageInner, (previousProps, nextProps) => previousProps.text === nextProps.text);
