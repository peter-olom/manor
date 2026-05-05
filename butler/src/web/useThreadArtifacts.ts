import { useEffect, useState } from "react";

import { getJson, postJson } from "./api";
import type { CodexThreadDetail, ProjectArtifact, ThreadArtifact } from "./types";

export function useThreadArtifacts(
  activeThread: CodexThreadDetail | null,
  showErrorToast: (error: unknown, key?: string, duration?: number) => void,
  showToast: (message: string, tone?: "success" | "error" | "info", duration?: number, key?: string) => void
) {
  const [threadArtifacts, setThreadArtifacts] = useState<ThreadArtifact[]>([]);
  const [projectArtifacts, setProjectArtifacts] = useState<ProjectArtifact[]>([]);
  const [promotingThreadArtifactId, setPromotingThreadArtifactId] = useState<string | null>(null);

  function isKeptThreadArtifact(artifact: ProjectArtifact): boolean {
    return (
      artifact.source.kind === "generated" &&
      artifact.source.createdByThreadId === activeThread?.id &&
      typeof artifact.metadata.threadArtifactId === "string" &&
      artifact.metadata.threadArtifactId.length > 0
    );
  }

  useEffect(() => {
    if (!activeThread?.id) {
      setThreadArtifacts([]);
      return;
    }

    let cancelled = false;
    getJson<{ artifacts: ThreadArtifact[] }>(`/api/threads/${encodeURIComponent(activeThread.id)}/artifacts`)
      .then((payload) => {
        if (!cancelled) {
          setThreadArtifacts(payload.artifacts);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setThreadArtifacts([]);
          showErrorToast(error, "thread-artifacts", 3000);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeThread?.id, activeThread?.updatedAt, showErrorToast]);

  useEffect(() => {
    const projectId = activeThread?.supervisor.projectId;
    if (!projectId) {
      setProjectArtifacts([]);
      return;
    }

    let cancelled = false;
    getJson<{ artifacts: ProjectArtifact[] }>(`/api/project-artifacts/${encodeURIComponent(projectId)}`)
      .then((payload) => {
        if (!cancelled) {
          setProjectArtifacts(payload.artifacts.filter(isKeptThreadArtifact));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setProjectArtifacts([]);
          showErrorToast(error, "project-artifacts", 3000);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeThread?.id, activeThread?.supervisor.projectId, activeThread?.updatedAt, showErrorToast]);

  async function promoteThreadArtifact(artifact: ThreadArtifact) {
    if (!activeThread?.id || artifact.promotedProjectArtifactId || promotingThreadArtifactId) {
      return;
    }

    setPromotingThreadArtifactId(artifact.id);
    try {
      const payload = await postJson<{ artifact: ProjectArtifact | null }>(
        `/api/threads/${encodeURIComponent(activeThread.id)}/artifacts/promote`,
        { artifactId: artifact.id }
      );
      const promotedId = payload.artifact?.id ?? artifact.promotedProjectArtifactId;
      setThreadArtifacts((current) =>
        current.map((entry) => (entry.id === artifact.id ? { ...entry, promotedProjectArtifactId: promotedId ?? entry.promotedProjectArtifactId } : entry))
      );
      if (payload.artifact) {
        setProjectArtifacts((current) => [payload.artifact!, ...current.filter((entry) => entry.id !== payload.artifact!.id)]);
      }
      showToast("Artifact kept", "success", 3000, `artifact-promoted-${artifact.id}`);
    } catch (error) {
      showErrorToast(error, "thread-artifact-promote", 5000);
    } finally {
      setPromotingThreadArtifactId(null);
    }
  }

  function resetArtifacts() {
    setThreadArtifacts([]);
    setProjectArtifacts([]);
    setPromotingThreadArtifactId(null);
  }

  return {
    projectArtifacts,
    promotingThreadArtifactId,
    promoteThreadArtifact,
    resetArtifacts,
    threadArtifacts
  };
}
