import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { IndicatorPreset } from "../indicators/indicatorTypes.js";
import {
  cancelLocalImportJob,
  createLocalImportJob,
  fetchLocalIndicatorPresets,
  getLocalImportJob,
  listLocalDatasets,
  LocalDataApiError,
  type LocalDatasetManifest,
  type LocalImportInput,
  type LocalImportJob,
} from "./researchDataApi.js";
import { researchLibraryErrorMessage, waitResearchMs } from "./researchDataFormat.js";
import { t } from "../../i18n/index.js";

export type ResearchImportSubmitInput = LocalImportInput;

export async function pollResearchImportJob(
  initial: LocalImportJob,
  options: {
    getJob?: (jobId: string) => Promise<LocalImportJob>;
    delay?: (milliseconds: number) => Promise<void>;
    onUpdate?: (job: LocalImportJob) => void;
  } = {},
): Promise<LocalImportJob> {
  const getJob = options.getJob ?? getLocalImportJob;
  const delay = options.delay ?? waitResearchMs;
  let job = initial;
  options.onUpdate?.(job);
  while (job.status === "queued" || job.status === "running") {
    await delay(250);
    job = await getJob(job.job_id);
    options.onUpdate?.(job);
  }
  return job;
}

export function useResearchDataLibrary() {
  const [datasets, setDatasets] = useState<LocalDatasetManifest[]>([]);
  const [indicatorPresets, setIndicatorPresets] = useState<IndicatorPreset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importJob, setImportJob] = useState<LocalImportJob | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const importJobRef = useRef<LocalImportJob | null>(null);

  const refresh = useCallback(async (preferredId?: string) => {
    const loaded = await listLocalDatasets();
    setDatasets(loaded);
    setSelectedId((current) => {
      const candidate = preferredId ?? current;
      if (candidate && loaded.some((dataset) => dataset.dataset_id === candidate)) return candidate;
      return loaded[0]?.dataset_id ?? null;
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      listLocalDatasets(controller.signal),
      fetchLocalIndicatorPresets(controller.signal),
    ]).then(([loaded, presets]) => {
      setDatasets(loaded);
      setIndicatorPresets(presets);
      setSelectedId(loaded[0]?.dataset_id ?? null);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(researchLibraryErrorMessage(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingLibrary(false);
    });
    return () => controller.abort();
  }, []);

  const selected = useMemo(
    () => datasets.find((dataset) => dataset.dataset_id === selectedId) ?? null,
    [datasets, selectedId],
  );

  const handleImport = useCallback(async (input: ResearchImportSubmitInput): Promise<LocalDatasetManifest | null> => {
    setImporting(true);
    setImportJob(null);
    setUploadProgress(0);
    setError(null);
    const controller = new AbortController();
    importAbortRef.current = controller;
    try {
      const created = await createLocalImportJob(input, {
        signal: controller.signal,
        onUploadProgress: setUploadProgress,
      });
      importJobRef.current = created;
      setImportJob(created);
      setUploadProgress(1);
      const job = await pollResearchImportJob(created, {
        onUpdate: (next) => {
          importJobRef.current = next;
          setImportJob(next);
        },
      });
      if (job.status === "completed" && job.dataset !== null) {
        await refresh(job.dataset.dataset_id);
        return job.dataset;
      }
      if (job.status !== "cancelled") {
        throw new LocalDataApiError(
          job.error?.message ?? t("local.importFailed"),
          422,
          job.error?.code ?? "import_failed",
        );
      }
      return null;
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return null;
      setError(researchLibraryErrorMessage(reason));
      throw reason;
    } finally {
      importAbortRef.current = null;
      importJobRef.current = null;
      setImporting(false);
      setImportJob(null);
      setUploadProgress(null);
    }
  }, [refresh]);

  const cancelImport = useCallback(() => {
    importAbortRef.current?.abort();
    const jobId = importJobRef.current?.job_id;
    if (jobId !== undefined) {
      void cancelLocalImportJob(jobId).then((job) => {
        importJobRef.current = job;
        setImportJob(job);
      }).catch((reason: unknown) => setError(researchLibraryErrorMessage(reason)));
    }
  }, []);

  return {
    datasets,
    indicatorPresets,
    selectedId,
    selected,
    loadingLibrary,
    importing,
    importJob,
    uploadProgress,
    error,
    setError,
    setSelectedId,
    refresh,
    handleImport,
    cancelImport,
  };
}

export type ResearchDataLibraryController = ReturnType<typeof useResearchDataLibrary>;
