import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { SpriteLibrarySnapshot, SpriteProjectSummary } from "@synara/contracts/spriteLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { newSpriteProject, type SpriteProject } from "./spriteModel";
import { importSpriteProject } from "./spriteFiles";
import {
  listSpriteProjects,
  getSpriteProject,
  saveSpriteProject,
  renameSpriteProject,
  deleteSpriteProject,
  readSpriteThumbnail,
  revealSpriteDirectory,
  spriteErrorMessage,
} from "./spriteStorage";
import SpriteWorkbench from "./SpriteWorkbench";

function ProjectThumbnail({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true,
      objectUrl: string | null = null;
    void readSpriteThumbnail(id)
      .then((blob) => {
        if (blob && alive) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  return (
    <div className="flex h-36 items-center justify-center rounded bg-muted/50">
      {url ? (
        <img src={url} alt="" className="h-32 w-32 object-contain [image-rendering:pixelated]" />
      ) : (
        <span className="text-3xl text-muted-foreground" aria-hidden>
          ◇
        </span>
      )}
    </div>
  );
}
export default function SpriteLibrary({ projectId }: { projectId?: string | undefined }) {
  const tr = useAhaTranslation(),
    navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<SpriteLibrarySnapshot | null>(null);
  const [project, setProject] = useState<SpriteProject | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{ id: string | null; name: string } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => setSnapshot(await listSpriteProjects()), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    setProject(null);
    void (
      projectId
        ? getSpriteProject(projectId).then((p) => {
            if (alive) setProject(p);
          })
        : listSpriteProjects().then((s) => {
            if (alive) setSnapshot(s);
          })
    )
      .catch((e) => {
        if (alive) setError(spriteErrorMessage(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(spriteErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const open = async (id: string) => {
    await navigate({ to: "/sprite-animation", search: { projectId: id } });
  };
  const back = async () => {
    await navigate({ to: "/sprite-animation", search: {} });
  };
  const remove = async (p: SpriteProjectSummary) => {
    if (
      !p.deleting &&
      !window.confirm(
        tr(
          "Delete this sprite project and its generation records? Conversation history will be kept.",
        ),
      )
    )
      return;
    await run(async () => {
      try {
        await deleteSpriteProject(p.id);
      } finally {
        await refresh();
      }
    });
  };
  if (loading) return <div className="p-6">{tr("Loading…")}</div>;
  if (projectId && project)
    return <SpriteWorkbench key={project.id} initialProject={project} onBack={back} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6" data-testid="sprite-library">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-lg font-semibold">{tr("Sprite animation")}</h1>
        {projectId && (
          <Button variant="outline" onClick={() => void back()}>
            {tr("Back to projects")}
          </Button>
        )}
        <Button disabled={busy} onClick={() => setDialog({ id: null, name: "" })}>
          {tr("New sprite project")}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => importRef.current?.click()}>
          {tr("Import project package")}
        </Button>
      </header>
      <p className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          {snapshot?.root
            ? `${tr("Save location")}: ${snapshot.root}`
            : window.desktopBridge
              ? tr("Sprite projects are saved in your Documents folder.")
              : tr("Projects are saved in this browser. Clearing browser data removes them.")}
        </span>
        {snapshot?.root && (
          <Button size="sm" variant="ghost" onClick={() => void run(revealSpriteDirectory)}>
            {tr("Open in Finder")}
          </Button>
        )}
      </p>
      {error && (
        <div
          role="alert"
          className="mb-4 rounded border border-destructive p-3 text-sm text-destructive"
        >
          {tr(error)}{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run(async () => {
                if (projectId) setProject(await getSpriteProject(projectId));
                else await refresh();
              })
            }
          >
            {tr("Retry")}
          </Button>
        </div>
      )}
      {!projectId && (
        <>
          <input
            className="mb-5 h-9 max-w-sm rounded border bg-background px-3 text-sm"
            aria-label={tr("Search sprite projects")}
            placeholder={tr("Search sprite projects")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!snapshot?.projects.length && !error && (
            <p className="py-12 text-center text-muted-foreground">
              {tr("No sprite projects yet. Create a project or import a project package.")}
            </p>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {snapshot?.projects
              .filter((p) => p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
              .map((p) => (
                <article key={`${p.id}-${p.updatedAt}`} className="rounded-lg border p-3">
                  <button
                    className="w-full text-left disabled:opacity-60"
                    disabled={busy || p.deleting || !!p.error}
                    onClick={() => void open(p.id)}
                    aria-label={`${tr("Open project")}: ${p.name}`}
                  >
                    <ProjectThumbnail id={p.id} />
                    <h2 className="mt-3 truncate font-medium">{p.name}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {p.actionCount} {tr("Actions")} ·{" "}
                      {p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "—"}
                    </p>
                  </button>
                  {p.error && <p className="mt-2 text-xs text-destructive">{p.error}</p>}
                  {p.deleting && (
                    <p className="mt-2 text-xs text-destructive">
                      {tr("Deletion incomplete. Retry to finish removing this project.")}
                    </p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || p.deleting || !!p.error}
                      onClick={() => setDialog({ id: p.id, name: p.name })}
                    >
                      {tr("Rename")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void remove(p)}
                    >
                      {tr(p.deleting ? "Retry deletion" : "Delete")}
                    </Button>
                  </div>
                </article>
              ))}
          </div>
        </>
      )}
      <Dialog
        open={!!dialog}
        onOpenChange={(value) => {
          if (!value && !busy) setDialog(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {tr(dialog?.id ? "Rename sprite project" : "New sprite project")}
            </DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            className="mx-4 my-3 h-9 rounded border bg-background px-3 text-sm"
            aria-label={tr("Project name")}
            maxLength={200}
            value={dialog?.name ?? ""}
            onChange={(e) => setDialog((d) => (d ? { ...d, name: e.target.value } : null))}
          />
          {error && (
            <p role="alert" className="px-4 text-sm text-destructive">
              {tr(error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              disabled={busy || !dialog?.name.trim()}
              onClick={() =>
                void run(async () => {
                  if (!dialog) return;
                  if (dialog.id) {
                    await renameSpriteProject(dialog.id, dialog.name);
                    await refresh();
                    setDialog(null);
                  } else {
                    const p = { ...newSpriteProject(), name: dialog.name.trim() };
                    await saveSpriteProject(p);
                    setDialog(null);
                    await open(p.id);
                  }
                })
              }
            >
              {tr(dialog?.id ? "Save" : "Create")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <input
        ref={importRef}
        hidden
        type="file"
        accept=".zip"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file)
            void run(async () => {
              const p = await importSpriteProject(file);
              await saveSpriteProject(p);
              await open(p.id);
            });
        }}
      />
    </div>
  );
}
