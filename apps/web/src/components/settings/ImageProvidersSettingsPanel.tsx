import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ImageModel,
  ImageProvider,
  ImageProviderInput,
  ImageProviderModel,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import {
  drawingApi,
  drawingProvidersKey,
  useImageProviders,
  useDrawingEvents,
} from "../drawing/useDrawing";

const newForm = (): ImageProviderInput => ({
  name: "",
  baseUrl: "",
  models: [],
  defaultModel: "",
  enabled: true,
  concurrency: 2,
  timeoutSeconds: 600,
});
export function ImageProvidersSettingsPanel({ active }: { active: boolean }) {
  const tr = useAhaTranslation();
  const client = useQueryClient();
  const query = useImageProviders();
  useDrawingEvents();
  const [form, setForm] = useState<ImageProviderInput | null>(null);
  const [key, setKey] = useState("");
  const [replaceKey, setReplaceKey] = useState(false);
  const [discovered, setDiscovered] = useState<readonly ImageModel[]>([]);
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState<string | null>(null);
  if (!active) return null;
  const open = (provider?: ImageProvider) => {
    setForm(provider ? { ...provider } : newForm());
    setKey("");
    setReplaceKey(!provider);
    setDiscovered([]);
    setSearch("");
    setError(null);
    setManual("");
  };
  const update = (patch: Partial<ImageProviderInput>) =>
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  const toggle = (id: string, source: ImageProviderModel["source"] = "discovered") => {
    if (!form) return;
    const models = form.models.some((m) => m.id === id)
      ? form.models.filter((m) => m.id !== id)
      : [...form.models, { id, source, lastTestAt: null, lastTestStatus: null }];
    update({
      models,
      defaultModel: models.some((m) => m.id === form.defaultModel)
        ? form.defaultModel
        : (models[0]?.id ?? ""),
    });
  };
  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      await drawingApi().upsertProvider({ ...form, ...(replaceKey ? { apiKey: key } : {}) });
      await client.invalidateQueries({ queryKey: drawingProvidersKey });
      setForm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const discover = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const result = await drawingApi().discoverModels({
        baseUrl: form.baseUrl,
        ...(form.id ? { id: form.id } : {}),
        ...(replaceKey ? { apiKey: key } : {}),
      });
      setDiscovered(result.models);
      if (!result.models.length)
        setError(tr("No models returned. You can add a model ID manually."));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const test = async (provider: ImageProvider, model: string) => {
    setTestBusy(`${provider.id}:${model}`);
    setError(null);
    try {
      await drawingApi().testModel({
        id: provider.id,
        model,
        clientRequestId: crypto.randomUUID(),
      });
      await client.invalidateQueries({ queryKey: ["drawing", "jobs"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTestBusy(null);
    }
  };
  const remove = async (provider: ImageProvider) => {
    if (
      !(await ensureNativeApi().dialogs.confirm(tr("Delete image provider?") + ` ${provider.name}`))
    )
      return;
    try {
      await drawingApi().deleteProvider({ id: provider.id });
      await client.invalidateQueries({ queryKey: drawingProvidersKey });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="space-y-5" aria-label={tr("Image providers")}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{tr("Image providers")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {tr("Configure independent image APIs and choose models.")}
          </p>
        </div>
        <Button onClick={() => open()}>{tr("Add image provider")}</Button>
      </div>
      {error && !form ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {query.isPending ? (
        <p>{tr("Loading...")}</p>
      ) : query.isError ? (
        <p role="alert">{query.error.message}</p>
      ) : !query.data?.length ? (
        <div className="rounded-2xl border border-dashed p-8 text-center text-muted-foreground">
          {tr("Add an image provider to start drawing.")}
        </div>
      ) : null}
      {query.data?.map((provider) => (
        <article key={provider.id} className="rounded-2xl border p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-medium">
                {provider.name}{" "}
                {!provider.enabled ? (
                  <span className="text-xs text-muted-foreground">({tr("Disabled")})</span>
                ) : null}
              </h3>
              <p className="text-xs text-muted-foreground break-all">{provider.baseUrl}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => open(provider)}>
                {tr("Edit")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void remove(provider)}>
                {tr("Delete")}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {tr(provider.apiKeyConfigured ? "API Key configured" : "No API Key configured")} ·{" "}
            {tr("Concurrency")}: {provider.concurrency} · {provider.timeoutSeconds}s
          </p>
          <div className="space-y-2">
            {provider.models.map((model) => (
              <div key={model.id} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="flex-1 break-all">
                  {model.id}
                  {provider.defaultModel === model.id ? ` · ${tr("Default")}` : ""}
                </span>
                {model.lastTestStatus ? (
                  <span className="text-xs text-muted-foreground">{tr(model.lastTestStatus)}</span>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!provider.enabled || testBusy !== null}
                  onClick={() => void test(provider, model.id)}
                >
                  {tr("Test generation (1 API call)")}
                </Button>
              </div>
            ))}
          </div>
        </article>
      ))}
      <Dialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setForm(null);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{tr(form?.id ? "Edit image provider" : "Add image provider")}</DialogTitle>
            <DialogDescription>
              {tr(
                "Discover models without generating images. Generation tests are separate paid API calls.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {form ? (
              <form
                id="image-provider-form"
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <label className="block space-y-1">
                  <span className="text-sm">{tr("Name")}</span>
                  <Input
                    required
                    value={form.name}
                    onChange={(e) => update({ name: e.target.value })}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">Base URL</span>
                  <Input
                    required
                    type="url"
                    placeholder="https://example.com/v1"
                    value={form.baseUrl}
                    onChange={(e) => update({ baseUrl: e.target.value })}
                  />
                  <span className="text-xs text-muted-foreground">
                    {tr("Use the API root path. /v1 is not added automatically.")}
                  </span>
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">API Key</span>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder={form.id && !replaceKey ? tr("Leave unchanged") : ""}
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value);
                      setReplaceKey(true);
                    }}
                  />
                </label>
                {form.id ? (
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={replaceKey}
                      onChange={(e) => setReplaceKey(e.target.checked)}
                    />
                    {tr("Replace API Key (empty removes it)")}
                  </label>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !form.baseUrl}
                    onClick={() => void discover()}
                  >
                    {tr(busy ? "Discovering..." : "Discover models")}
                  </Button>
                  <Input
                    className="min-w-32 flex-1"
                    aria-label={tr("Search models")}
                    placeholder={tr("Search models")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {discovered.length ? (
                  <div className="max-h-40 overflow-auto rounded-xl border p-2 space-y-1">
                    {discovered
                      .filter((m) => m.id.toLowerCase().includes(search.toLowerCase()))
                      .map((model) => (
                        <label key={model.id} className="flex items-center gap-2 py-1 text-sm">
                          <input
                            type="checkbox"
                            checked={form.models.some((m) => m.id === model.id)}
                            onChange={() => toggle(model.id)}
                          />
                          <span className="break-all">{model.id}</span>
                          {model.imageHint ? (
                            <span className="text-xs text-muted-foreground">
                              {tr("Image hint")}
                            </span>
                          ) : null}
                        </label>
                      ))}
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <Input
                    aria-label={tr("Model ID")}
                    placeholder={tr("Add model ID manually")}
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!manual.trim()}
                    onClick={() => {
                      if (!form.models.some((m) => m.id === manual.trim()))
                        toggle(manual.trim(), "manual");
                      setManual("");
                    }}
                  >
                    {tr("Add")}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {form.models.map((m) => (
                    <Button
                      key={m.id}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => toggle(m.id, m.source)}
                      aria-label={`${tr("Remove model")} ${m.id}`}
                    >
                      {m.id} ×
                    </Button>
                  ))}
                </div>
                <label className="block space-y-1">
                  <span className="text-sm">{tr("Default model")}</span>
                  <select
                    className="w-full rounded-lg border bg-background p-2 text-sm"
                    value={form.defaultModel}
                    onChange={(e) => update({ defaultModel: e.target.value })}
                  >
                    {!form.models.length ? (
                      <option value="">{tr("Choose models first")}</option>
                    ) : null}
                    {form.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1 text-sm">
                    {tr("Concurrency")}
                    <Input
                      type="number"
                      min={1}
                      max={8}
                      value={form.concurrency}
                      onChange={(e) => update({ concurrency: Number(e.target.value) })}
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    {tr("Timeout (seconds)")}
                    <Input
                      type="number"
                      min={30}
                      max={1800}
                      value={form.timeoutSeconds}
                      onChange={(e) => update({ timeoutSeconds: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => update({ enabled: e.target.checked })}
                  />
                  {tr("Enabled")}
                </label>
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </form>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setForm(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              type="submit"
              form="image-provider-form"
              disabled={busy || !form?.models.length}
            >
              {tr("Save")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
