import { useState } from "react";
import "./ContactImportPage.css";
import ImportUploadStep from "./ImportUploadStep";
import ImportMappingStep from "./ImportMappingStep";
import ImportPreviewStep from "./ImportPreviewStep";
import ImportConfirmStep from "./ImportConfirmStep";
import ImportResultsStep from "./ImportResultsStep";
import type { ConfirmResponse, PreviewResponse, UploadResponse } from "./types";

type Step = "upload" | "map" | "preview" | "confirm" | "results";

const STEP_LABELS: { step: Step; label: string }[] = [
  { step: "upload", label: "Upload" },
  { step: "map", label: "Map Columns" },
  { step: "preview", label: "Preview & Validate" },
  { step: "confirm", label: "Confirm" },
  { step: "results", label: "Results" },
];

interface ContactImportPageProps {
  onDone: () => void;
}

export default function ContactImportPage({ onDone }: ContactImportPageProps): JSX.Element {
  const [step, setStep] = useState<Step>("upload");
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [previewResult, setPreviewResult] = useState<PreviewResponse | null>(null);
  const [decisions, setDecisions] = useState<Map<string, { selected: boolean; confirmDuplicate: boolean }>>(new Map());
  const [confirmResult, setConfirmResult] = useState<ConfirmResponse | null>(null);

  const stepIndex = STEP_LABELS.findIndex((s) => s.step === step);

  return (
    <div className="contact-import-page">
      <h2 className="page-heading">Import Contacts</h2>
      <p className="page-lede">Bring contacts in from a CSV or Excel export — reviewed and confirmed by you before anything is created.</p>

      <ol className="import-wizard-steps">
        {STEP_LABELS.map((s, i) => (
          <li key={s.step} className={i === stepIndex ? "is-active" : i < stepIndex ? "is-done" : ""}>
            {s.label}
          </li>
        ))}
      </ol>

      <div className="card card-pad">
        {step === "upload" && (
          <ImportUploadStep
            onUploaded={(result) => {
              setUploadResult(result);
              setStep("map");
            }}
          />
        )}

        {step === "map" && uploadResult && (
          <ImportMappingStep
            upload={uploadResult}
            onBack={() => setStep("upload")}
            onMapped={(result) => {
              setPreviewResult(result);
              setDecisions(new Map());
              setStep("preview");
            }}
          />
        )}

        {step === "preview" && previewResult && (
          <ImportPreviewStep
            batch={previewResult.batch}
            initialRows={previewResult.rows}
            initialTotal={previewResult.total}
            decisions={decisions}
            onDecisionsChange={setDecisions}
            onBack={() => setStep("map")}
            onContinue={() => setStep("confirm")}
          />
        )}

        {step === "confirm" && previewResult && (
          <ImportConfirmStep
            batch={previewResult.batch}
            decisions={decisions}
            onBack={() => setStep("preview")}
            onConfirmed={(result) => {
              setConfirmResult(result);
              setStep("results");
            }}
          />
        )}

        {step === "results" && confirmResult && <ImportResultsStep result={confirmResult} onDone={onDone} />}
      </div>
    </div>
  );
}
