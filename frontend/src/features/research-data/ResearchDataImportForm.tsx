import { useRef, useState } from "react";

import { t } from "../../i18n/index.js";
import type { LocalDatasetManifest, LocalImportJob } from "./researchDataApi.js";
import { formatResearchRows } from "./researchDataFormat.js";
import type { ResearchImportSubmitInput } from "./useResearchDataLibrary.js";

export function ResearchDataImportForm({
  importing,
  importJob,
  uploadProgress,
  selected,
  onCancel,
  onImport,
}: {
  importing: boolean;
  importJob: LocalImportJob | null;
  uploadProgress: number | null;
  selected: LocalDatasetManifest | null;
  onCancel(): void;
  onImport(input: ResearchImportSubmitInput): Promise<unknown>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("BTC-USDT");
  const [interval, setInterval] = useState("1m");
  const [timezone, setTimezone] = useState("UTC");
  const [timestampUnit, setTimestampUnit] = useState<"auto" | "s" | "ms" | "iso">("auto");
  const [volumeRequired, setVolumeRequired] = useState(false);
  const [asRevision, setAsRevision] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <form
      className="local-import-form"
      data-testid="research-data-import-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (file === null) return;
        void onImport({
          file,
          name: name.trim() || file.name.replace(/\.csv$/i, ""),
          symbol,
          interval,
          timezone,
          timestampUnit,
          volumeRequired,
          ...(asRevision && selected !== null ? { datasetId: selected.dataset_id } : {}),
        }).then(() => {
          setFile(null);
          setName("");
          if (fileInputRef.current !== null) fileInputRef.current.value = "";
        }).catch(() => undefined);
      }}
    >
      <header>
        <div>
          <span>{t("local.kicker.import")}</span>
          <strong>{t("local.import")}</strong>
        </div>
        <small>{t("local.localOnly")}</small>
      </header>
      <label className="local-file-picker">
        <span>{file?.name ?? t("local.chooseFile")}</span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </label>
      <label>
        {t("local.datasetName")}
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("local.namePh")} />
      </label>
      <div className="local-import-grid">
        <label>
          {t("local.symbol")}
          <input required value={symbol} onChange={(event) => setSymbol(event.target.value)} />
        </label>
        <label>
          {t("local.interval")}
          <input required value={interval} onChange={(event) => setInterval(event.target.value)} placeholder="1m" />
        </label>
        <label>
          {t("local.timezone")}
          <input required value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="UTC" />
        </label>
        <label>
          {t("local.timeFormat")}
          <select value={timestampUnit} onChange={(event) => setTimestampUnit(event.target.value as typeof timestampUnit)}>
            <option value="auto">{t("local.autoDetect")}</option>
            <option value="s">{t("local.unixS")}</option>
            <option value="ms">{t("local.unixMs")}</option>
            <option value="iso">{t("local.iso")}</option>
          </select>
        </label>
        <label>
          {t("local.volume")}
          <select
            value={volumeRequired ? "required" : "optional"}
            onChange={(event) => setVolumeRequired(event.target.value === "required")}
          >
            <option value="optional">{t("local.volumeOptional")}</option>
            <option value="required">{t("local.volumeRequired")}</option>
          </select>
        </label>
      </div>
      <p>{t("local.requiredCols")}</p>
      {selected !== null && (
        <label className="local-revision-choice">
          <input
            type="checkbox"
            checked={asRevision}
            onChange={(event) => setAsRevision(event.target.checked)}
          />
          {t("local.asRevision", { name: selected.name })}
        </label>
      )}
      <button type="submit" disabled={file === null || importing}>
        {importing ? t("local.importing") : t("local.importBtn")}
      </button>
      {importing && (
        <div className="local-import-progress" role="status">
          <div><span>{importJob?.stage ?? "uploading"}</span><b>{importJob ? t("local.rows", { count: formatResearchRows(importJob.processed_rows) }) : `${Math.round((uploadProgress ?? 0) * 100)}%`}</b></div>
          <progress value={importJob?.total_rows ? importJob.processed_rows / importJob.total_rows : (uploadProgress ?? undefined)} />
          <button type="button" onClick={onCancel}>{t("local.cancelImport")}</button>
        </div>
      )}
    </form>
  );
}
