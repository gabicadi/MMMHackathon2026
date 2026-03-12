import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

/**
 * Vite + React friendly MMM Scenario Planner (single-file component)
 * -----------------------------------------------------------------
 * This component is self-contained: no shadcn/ui imports and no path aliases.
 *
 * Dependencies:
 *   npm i recharts
 *
 * How it matches the notebook exactly:
 * 1) Sliders control TOTAL period spend per channel.
 * 2) Weekly spend SHAPE is preserved and rescaled to hit new totals.
 * 3) Adstock over time uses your exact function:
 *      impact[t] = spend[t] + alpha * impact[t-1]
 * 4) Hill uses fixed normalization anchors from baseline:
 *      x_norm[t] = adstock[t] / ref_max_adstock[channel]
 *      hill[t]   = x_norm^S / (K^S + x_norm^S)
 * 5) Predictions update with delta method:
 *      y_new = y_pred + Σ coef[channel] * (hill_new - hill_baseline)
 *
 * Auto-load option (recommended for GitHub/Vite deployments):
 * - Put these three files in your Vite project's /public folder:
 *     public/scenario_inputs.csv
 *     public/y_pred.csv
 *     public/scenario_params.json
 * - The app will fetch them on page load.
 * - Manual upload remains available as a fallback.
 */

// -----------------------------
// Types
// -----------------------------
type Params = {
  TV: { alpha: number; k: number; s: number };
  Search: { alpha: number; k: number; s: number };
  Social: { alpha: number; k: number; s: number };
  ref_max_adstock: Record<string, number>;
  coef: {
    tv_2023_transformed: number;
    tv_2024_2025_transformed: number;
    search_transformed: number;
    social_transformed: number;
  };
};

type DataRow = {
  date: string;
  tv_2023: number;
  tv_2024_2025: number;
  search_spend_clean: number;
  social_spend_clean: number;
};

// -----------------------------
// Utilities
// -----------------------------
function formatInt(n: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}
function formatFloat(n: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
}
function safeNum(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function sum(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0);
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

// Minimal CSV parser (no deps). Handles CRLF/LF, no quoted commas.
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split(",").map((s) => s.trim());
  const rows = lines.slice(1).map((l) => l.split(",").map((s) => s.trim()));
  return { header, rows };
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

function scaleToTotal(series: number[], newTotal: number): number[] {
  const baseTotal = sum(series);
  if (baseTotal <= 0) return series.map(() => 0);
  const mult = newTotal / baseTotal;
  return series.map((v) => v * mult);
}

// -----------------------------
// Exact adstock (your function)
// -----------------------------
function adstockGeometric(series: number[], alpha: number): number[] {
  const x = series.map((v) => safeNum(v));
  if (alpha === 0) return x;

  const out = new Array(x.length).fill(0);
  for (let t = 0; t < x.length; t++) {
    out[t] = x[t] + (t > 0 ? alpha * out[t - 1] : 0.0);
  }
  return out;
}

function hill(xNorm: number, K: number, S: number) {
  const x = Math.max(0, xNorm);
  const num = Math.pow(x, S);
  const den = Math.pow(K, S) + num;
  return den === 0 ? 0 : num / den;
}

function getRef(params: Params, preferredKeys: string[], fallbackContains: string): number {
  for (const k of preferredKeys) {
    const v = params.ref_max_adstock[k];
    if (Number.isFinite(v) && v > 0) return v;
  }
  const matchKey = Object.keys(params.ref_max_adstock).find((k) => k.includes(fallbackContains));
  const v = matchKey ? params.ref_max_adstock[matchKey] : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// -----------------------------
// Self-tests (run once)
// -----------------------------
function runSelfTests() {
  const csv = "a,b\r\n1,2\n3,4\n";
  const p = parseCsv(csv);
  console.assert(p.header.join(",") === "a,b", "parseCsv header failed");
  console.assert(p.rows.length === 2 && p.rows[1][0] === "3", "parseCsv rows failed");

  const ad = adstockGeometric([1, 0, 0], 0.5);
  console.assert(Math.abs(ad[0] - 1) < 1e-9, "adstock t0 failed");
  console.assert(Math.abs(ad[1] - 0.5) < 1e-9, "adstock t1 failed");
  console.assert(Math.abs(ad[2] - 0.25) < 1e-9, "adstock t2 failed");
}

if (typeof window !== "undefined") {
  const w = window as any;
  if (!w.__MMM_SCENARIO_TESTS_RAN__) {
    w.__MMM_SCENARIO_TESTS_RAN__ = true;
    runSelfTests();
  }
}

// -----------------------------
// Tiny UI primitives (no deps)
// -----------------------------
function Card(props: React.PropsWithChildren<{ title?: string; className?: string }>) {
  return (
    <div
      className={
        "rounded-2xl border border-slate-200 bg-white shadow-sm " + (props.className || "")
      }
      style={{ padding: 16 }}
    >
      {props.title ? (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>{props.title}</div>
        </div>
      ) : null}
      {props.children}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "#e2e8f0", margin: "14px 0" }} />;
}

function Btn(props: React.PropsWithChildren<{ onClick?: () => void; variant?: "primary" | "secondary"; disabled?: boolean }>) {
  const isSecondary = props.variant === "secondary";
  return (
    <button
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        padding: "8px 10px",
        borderRadius: 12,
        border: "1px solid #e2e8f0",
        background: isSecondary ? "#f8fafc" : "#0f172a",
        color: isSecondary ? "#0f172a" : "#ffffff",
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.6 : 1,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {props.children}
    </button>
  );
}

function Badge(props: React.PropsWithChildren<{}>) {
  return (
    <span
      style={{
        display: "inline-flex",
        padding: "4px 10px",
        borderRadius: 999,
        background: "#f1f5f9",
        color: "#0f172a",
        border: "1px solid #e2e8f0",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {props.children}
    </span>
  );
}

function SliderRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>{props.label}</div>
        <div style={{ fontSize: 13, color: "#334155" }}>{formatFloat(props.value)}</div>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b" }}>
        <span>{formatFloat(props.min)}</span>
        <span>{formatFloat(props.max)}</span>
      </div>
    </div>
  );
}

// -----------------------------
// App
// -----------------------------
export default function App() {
  const [params, setParams] = useState<Params | null>(null);
  const [data, setData] = useState<DataRow[] | null>(null);
  const [yPred, setYPred] = useState<number[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const [totals, setTotals] = useState({
    tv_2023: 0,
    tv_2024_2025: 0,
    search: 0,
    social: 0,
  });

  // -----------------------------
  // Auto-load from /public on first render
  // -----------------------------
  // Put files here:
  //   public/scenario_inputs.csv
  //   public/y_pred.csv
  //   public/scenario_params.json
  //
  // Notes:
  // - For GitHub Pages / subpaths, Vite sets import.meta.env.BASE_URL.
  // - Disable quickly with ?autoload=0
  const AUTOLOAD = true;
  const AUTO_FILES = {
    inputs: "scenario_inputs.csv",
    ypred: "y_pred.csv",
    params: "scenario_params.json",
  };

  useEffect(() => {
    if (!AUTOLOAD) return;

    const qp = new URLSearchParams(window.location.search);
    if (qp.get("autoload") === "0") return;

    let cancelled = false;
    const base = (import.meta as any).env?.BASE_URL || "/";

    async function loadAll() {
      try {
        const [inputsTxt, ypredTxt, paramsObj] = await Promise.all([
          fetchText(`${base}${AUTO_FILES.inputs}`),
          fetchText(`${base}${AUTO_FILES.ypred}`),
          fetchJson<Params>(`${base}${AUTO_FILES.params}`),
        ]);

        if (cancelled) return;

        // params
        setParams(paramsObj);

        // scenario_inputs.csv
        {
          const parsed = parseCsv(inputsTxt);
          const idx = (name: string) => parsed.header.indexOf(name);
          const required = [
            "date",
            "tv_2023",
            "tv_2024_2025",
            "search_spend_clean",
            "social_spend_clean",
          ];
          const missing = required.filter((c) => idx(c) === -1);
          if (missing.length) {
            throw new Error(`scenario_inputs.csv missing columns: ${missing.join(", ")}`);
          }

          const rows: DataRow[] = parsed.rows.map((r) => ({
            date: r[idx("date")],
            tv_2023: safeNum(r[idx("tv_2023")]),
            tv_2024_2025: safeNum(r[idx("tv_2024_2025")]),
            search_spend_clean: safeNum(r[idx("search_spend_clean")]),
            social_spend_clean: safeNum(r[idx("social_spend_clean")]),
          }));

          setData(rows);

          // initialize slider totals to baseline totals
          const tv23 = sum(rows.map((d) => d.tv_2023));
          const tv24 = sum(rows.map((d) => d.tv_2024_2025));
          const se = sum(rows.map((d) => d.search_spend_clean));
          const so = sum(rows.map((d) => d.social_spend_clean));
          setTotals({ tv_2023: tv23, tv_2024_2025: tv24, search: se, social: so });
        }

        // y_pred.csv
        {
          const parsed = parseCsv(ypredTxt);
          const colIndex = parsed.header.findIndex((h) => h.toLowerCase() === "y_pred");
          if (colIndex === -1) {
            const all = [parsed.header, ...parsed.rows];
            setYPred(all.map((r) => safeNum(r[0])));
          } else {
            setYPred(parsed.rows.map((r) => safeNum(r[colIndex])));
          }
        }
      } catch (e: any) {
        // Non-fatal: manual upload still works.
        const msg = e?.message || String(e);
        setErrors((prev) => {
          if (prev.some((p) => p.includes("Auto-load") && p.includes(msg))) return prev;
          return [...prev, `Auto-load from /public failed: ${msg}`];
        });
      }
    }

    loadAll();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadParams(file: File) {
    try {
      const txt = await readFileAsText(file);
      const obj = JSON.parse(txt);
      setParams(obj);
    } catch (e: any) {
      setErrors((prev) => [...prev, `scenario_params.json: ${e?.message || String(e)}`]);
    }
  }

  async function loadInputsCsv(file: File) {
    try {
      const txt = await readFileAsText(file);
      const parsed = parseCsv(txt);
      const idx = (name: string) => parsed.header.indexOf(name);

      const required = [
        "date",
        "tv_2023",
        "tv_2024_2025",
        "search_spend_clean",
        "social_spend_clean",
      ];
      const missing = required.filter((c) => idx(c) === -1);
      if (missing.length) throw new Error(`missing columns: ${missing.join(", ")}`);

      const rows: DataRow[] = parsed.rows.map((r) => ({
        date: r[idx("date")],
        tv_2023: safeNum(r[idx("tv_2023")]),
        tv_2024_2025: safeNum(r[idx("tv_2024_2025")]),
        search_spend_clean: safeNum(r[idx("search_spend_clean")]),
        social_spend_clean: safeNum(r[idx("social_spend_clean")]),
      }));

      setData(rows);

      // initialize slider totals to baseline totals
      const tv23 = sum(rows.map((d) => d.tv_2023));
      const tv24 = sum(rows.map((d) => d.tv_2024_2025));
      const se = sum(rows.map((d) => d.search_spend_clean));
      const so = sum(rows.map((d) => d.social_spend_clean));
      setTotals({ tv_2023: tv23, tv_2024_2025: tv24, search: se, social: so });
    } catch (e: any) {
      setErrors((prev) => [...prev, `scenario_inputs.csv: ${e?.message || String(e)}`]);
    }
  }

  async function loadYPred(file: File) {
    try {
      const txt = await readFileAsText(file);
      const parsed = parseCsv(txt);
      const colIndex = parsed.header.findIndex((h) => h.toLowerCase() === "y_pred");

      if (colIndex === -1) {
        // no header: treat header row as first value row
        const all = [parsed.header, ...parsed.rows];
        setYPred(all.map((r) => safeNum(r[0])));
        return;
      }
      setYPred(parsed.rows.map((r) => safeNum(r[colIndex])));
    } catch (e: any) {
      setErrors((prev) => [...prev, `y_pred.csv: ${e?.message || String(e)}`]);
    }
  }

  const baseline = useMemo(() => {
    if (!data || !params || !yPred) return null;
    if (yPred.length !== data.length) {
      return { error: `y_pred length (${yPred.length}) must match inputs rows (${data.length}).` };
    }

    const tv23 = data.map((d) => d.tv_2023);
    const tv24 = data.map((d) => d.tv_2024_2025);
    const se = data.map((d) => d.search_spend_clean);
    const so = data.map((d) => d.social_spend_clean);

    const refTv23 = getRef(params, ["TV 2023"], "TV 2023");
    const refTv24 = getRef(params, ["TV 2024–25", "TV 2024-25", "TV 2024\u201325"], "TV 2024");
    const refSearch = getRef(params, ["Search"], "Search");
    const refSocial = getRef(params, ["Social"], "Social");

    const tvAd23 = adstockGeometric(tv23, params.TV.alpha);
    const tvAd24 = adstockGeometric(tv24, params.TV.alpha);
    const seAd = adstockGeometric(se, params.Search.alpha);
    const soAd = adstockGeometric(so, params.Social.alpha);

    const tvHill23 = tvAd23.map((a) => hill(refTv23 > 0 ? a / refTv23 : 0, params.TV.k, params.TV.s));
    const tvHill24 = tvAd24.map((a) => hill(refTv24 > 0 ? a / refTv24 : 0, params.TV.k, params.TV.s));
    const seHill = seAd.map((a) => hill(refSearch > 0 ? a / refSearch : 0, params.Search.k, params.Search.s));
    const soHill = soAd.map((a) => hill(refSocial > 0 ? a / refSocial : 0, params.Social.k, params.Social.s));

    return {
      tv23,
      tv24,
      se,
      so,
      yPred,
      tvHill23,
      tvHill24,
      seHill,
      soHill,
      refs: { refTv23, refTv24, refSearch, refSocial },
      baseSalesTotal: sum(yPred),
      baseTotals: {
        tv_2023: sum(tv23),
        tv_2024_2025: sum(tv24),
        search: sum(se),
        social: sum(so),
      },
    };
  }, [data, params, yPred]);

  const scenario = useMemo(() => {
    if (!baseline || (baseline as any).error || !params || !data) return null;

    const tv23New = scaleToTotal(baseline.tv23, totals.tv_2023);
    const tv24New = scaleToTotal(baseline.tv24, totals.tv_2024_2025);
    const seNew = scaleToTotal(baseline.se, totals.search);
    const soNew = scaleToTotal(baseline.so, totals.social);

    const tvAd23 = adstockGeometric(tv23New, params.TV.alpha);
    const tvAd24 = adstockGeometric(tv24New, params.TV.alpha);
    const seAd = adstockGeometric(seNew, params.Search.alpha);
    const soAd = adstockGeometric(soNew, params.Social.alpha);

    const tvHill23 = tvAd23.map((a) => hill(baseline.refs.refTv23 > 0 ? a / baseline.refs.refTv23 : 0, params.TV.k, params.TV.s));
    const tvHill24 = tvAd24.map((a) => hill(baseline.refs.refTv24 > 0 ? a / baseline.refs.refTv24 : 0, params.TV.k, params.TV.s));
    const seHill = seAd.map((a) => hill(baseline.refs.refSearch > 0 ? a / baseline.refs.refSearch : 0, params.Search.k, params.Search.s));
    const soHill = soAd.map((a) => hill(baseline.refs.refSocial > 0 ? a / baseline.refs.refSocial : 0, params.Social.k, params.Social.s));

    const yNew = baseline.yPred.map((y, i) => {
      const dTv23 = params.coef.tv_2023_transformed * (tvHill23[i] - baseline.tvHill23[i]);
      const dTv24 = params.coef.tv_2024_2025_transformed * (tvHill24[i] - baseline.tvHill24[i]);
      const dSe = params.coef.search_transformed * (seHill[i] - baseline.seHill[i]);
      const dSo = params.coef.social_transformed * (soHill[i] - baseline.soHill[i]);
      return y + dTv23 + dTv24 + dSe + dSo;
    });

    const totalSales = sum(yNew);

    // Per-channel deltas (contribution change vs baseline)
    const dTv23 = baseline.yPred.map((_, i) => params.coef.tv_2023_transformed * (tvHill23[i] - baseline.tvHill23[i]));
    const dTv24 = baseline.yPred.map((_, i) => params.coef.tv_2024_2025_transformed * (tvHill24[i] - baseline.tvHill24[i]));
    const dSe   = baseline.yPred.map((_, i) => params.coef.search_transformed * (seHill[i] - baseline.seHill[i]));
    const dSo   = baseline.yPred.map((_, i) => params.coef.social_transformed * (soHill[i] - baseline.soHill[i]));

    return {
      totalSales,
      deltaSales: totalSales - baseline.baseSalesTotal,
      deltaPct: baseline.baseSalesTotal > 0 ? (totalSales - baseline.baseSalesTotal) / baseline.baseSalesTotal : 0,
      totals: {
        tv_2023: sum(tv23New),
        tv_2024_2025: sum(tv24New),
        search: sum(seNew),
        social: sum(soNew),
      },
      // Stacked contribution chart: baseline prediction + per-channel deltas = scenario prediction
      chart: data.map((d, i) => ({
        date: d.date,
        base: baseline.yPred[i],
        tv_2023: dTv23[i],
        tv_2024_2025: dTv24[i],
        search: dSe[i],
        social: dSo[i],
        scenario: yNew[i],
      })),
    };
  }, [baseline, params, totals, data]);

  const sliderBounds = useMemo(() => {
    if (!baseline || (baseline as any).error) {
      return {
        tv_2023: { min: 0, max: 100, step: 1 },
        tv_2024_2025: { min: 0, max: 100, step: 1 },
        search: { min: 0, max: 100, step: 1 },
        social: { min: 0, max: 100, step: 1 },
      };
    }
    const b = baseline.baseTotals;
    const make = (v: number) => ({ min: 0, max: Math.max(1, v * 2.0), step: Math.max(0.1, v / 200) });
    return {
      tv_2023: make(b.tv_2023),
      tv_2024_2025: make(b.tv_2024_2025),
      search: make(b.search),
      social: make(b.social),
    };
  }, [baseline]);

  const pieData = useMemo(() => {
    if (!scenario) return [];
    return [
      { name: "TV 2023", value: scenario.totals.tv_2023 },
      { name: "TV 2024–25", value: scenario.totals.tv_2024_2025 },
      { name: "Search", value: scenario.totals.search },
      { name: "Social", value: scenario.totals.social },
    ];
  }, [scenario]);

  const pieTotal = useMemo(() => sum(pieData.map((p) => p.value)), [pieData]);
  const COLORS = ["#0f172a", "#334155", "#64748b", "#94a3b8"]; // neutral

  function resetToBaseline() {
    if (!baseline || (baseline as any).error) return;
    setTotals({ ...baseline.baseTotals });
  }

  const ready = !!(params && data && yPred && baseline && !(baseline as any).error);

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", color: "#0f172a" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800 }}>MMM Scenario Planner</div>
              <div style={{ fontSize: 13, color: "#475569", marginTop: 4 }}>
                Drop this component into a Vite + React project. Upload your artifacts and explore scenarios.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="secondary" onClick={() => setErrors([])}>
                Clear errors
              </Btn>
              <Btn onClick={resetToBaseline} disabled={!ready}>
                Reset to baseline
              </Btn>
            </div>
          </div>

          <Card title="1) Upload artifacts">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>scenario_inputs.csv</div>
                <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && loadInputsCsv(e.target.files[0])} />
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
                  Columns: date, tv_2023, tv_2024_2025, search_spend_clean, social_spend_clean
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>y_pred.csv</div>
                <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && loadYPred(e.target.files[0])} />
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>Single column: y_pred</div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>scenario_params.json</div>
                <input type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && loadParams(e.target.files[0])} />
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>alpha/k/s, ref_max_adstock, coef</div>
              </div>
            </div>

            {errors.length > 0 ? (
              <div style={{ marginTop: 10, padding: 10, borderRadius: 14, background: "#fff1f2", border: "1px solid #fecdd3" }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#881337" }}>Errors</div>
                <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 12, color: "#881337" }}>
                  {errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {baseline && (baseline as any).error ? (
              <div style={{ marginTop: 10, padding: 10, borderRadius: 14, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12 }}>
                {(baseline as any).error}
              </div>
            ) : null}
          </Card>

          <Card title="2) Scenario controls">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, alignItems: "start" }}>
              <div style={{ gridColumn: "span 2" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800 }}>Predicted total sales</div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>Scenario vs baseline</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 22, fontWeight: 900 }}>{scenario ? formatInt(scenario.totalSales) : "—"}</div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>
                      {scenario ? `${formatInt(scenario.deltaSales)} (${formatFloat(scenario.deltaPct * 100)}%) vs base` : ""}
                    </div>
                  </div>
                </div>

                <Divider />

                <div style={{ height: 280, border: "1px solid #e2e8f0", borderRadius: 16, padding: 10, background: "#ffffff" }}>
                  <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8 }}>
                    Weekly stacked contribution layer chart
                  </div>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
                    Baseline prediction plus per-channel scenario deltas (TV 2023, TV 2024–25, Search, Social). Sum equals scenario.
                  </div>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={scenario?.chart || []}
                      margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
                      stackOffset="sign"
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" hide />
                      <YAxis tickFormatter={(v) => String(Math.round(v))} />
                      <Tooltip
                        formatter={(value: any, name: any) => [formatInt(Number(value)), String(name)]}
                        labelFormatter={(l) => `Date: ${l}`}
                      />

                      {/* Base layer */}
                      <Area
                        type="monotone"
                        dataKey="base"
                        name="Baseline prediction"
                        stackId="1"
                        stroke="#64748b"
                        fill="#94a3b8"
                        fillOpacity={0.45}
                        strokeWidth={1.5}
                        dot={false}
                      />

                      {/* Delta layers */}
                      <Area
                        type="monotone"
                        dataKey="tv_2023"
                        name="TV 2023 delta"
                        stackId="1"
                        stroke="#0f172a"
                        fill="#0f172a"
                        fillOpacity={0.18}
                        strokeWidth={1.2}
                        dot={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="tv_2024_2025"
                        name="TV 2024–25 delta"
                        stackId="1"
                        stroke="#334155"
                        fill="#334155"
                        fillOpacity={0.16}
                        strokeWidth={1.2}
                        dot={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="search"
                        name="Search delta"
                        stackId="1"
                        stroke="#475569"
                        fill="#475569"
                        fillOpacity={0.14}
                        strokeWidth={1.2}
                        dot={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="social"
                        name="Social delta"
                        stackId="1"
                        stroke="#64748b"
                        fill="#64748b"
                        fillOpacity={0.12}
                        strokeWidth={1.2}
                        dot={false}
                      />

                      {/* Optional outline of scenario total (no fill) */}
                      <Area
                        type="monotone"
                        dataKey="scenario"
                        name="Scenario total"
                        stroke="#111827"
                        fillOpacity={0}
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800 }}>Budget controls</div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>Total spend over full period</div>
                  </div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    {scenario
                      ? `Total: ${formatFloat(
                          scenario.totals.tv_2023 + scenario.totals.tv_2024_2025 + scenario.totals.search + scenario.totals.social
                        )}`
                      : "—"}
                  </div>
                </div>

                <Divider />

                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <SliderRow
                    label="TV 2023"
                    value={totals.tv_2023}
                    min={sliderBounds.tv_2023.min}
                    max={sliderBounds.tv_2023.max}
                    step={sliderBounds.tv_2023.step}
                    onChange={(v) => setTotals((p) => ({ ...p, tv_2023: v }))}
                  />
                  <SliderRow
                    label="TV 2024–25"
                    value={totals.tv_2024_2025}
                    min={sliderBounds.tv_2024_2025.min}
                    max={sliderBounds.tv_2024_2025.max}
                    step={sliderBounds.tv_2024_2025.step}
                    onChange={(v) => setTotals((p) => ({ ...p, tv_2024_2025: v }))}
                  />
                  <SliderRow
                    label="Search"
                    value={totals.search}
                    min={sliderBounds.search.min}
                    max={sliderBounds.search.max}
                    step={sliderBounds.search.step}
                    onChange={(v) => setTotals((p) => ({ ...p, search: v }))}
                  />
                  <SliderRow
                    label="Social"
                    value={totals.social}
                    min={sliderBounds.social.min}
                    max={sliderBounds.social.max}
                    step={sliderBounds.social.step}
                    onChange={(v) => setTotals((p) => ({ ...p, social: v }))}
                  />
                </div>

                <Divider />

                <div style={{ fontSize: 13, fontWeight: 800 }}>Budget distribution</div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Pie chart updates in real time</div>
                <div style={{ height: 240, marginTop: 10 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pieData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={78}
                        label={(entry: any) =>
                          pieTotal > 0 ? `${entry.name}: ${Math.round((entry.value / pieTotal) * 100)}%` : entry.name
                        }
                      >
                        {pieData.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>

                {scenario ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                    <Badge>TV 2023: {formatFloat(scenario.totals.tv_2023)}</Badge>
                    <Badge>TV 2024–25: {formatFloat(scenario.totals.tv_2024_2025)}</Badge>
                    <Badge>Search: {formatFloat(scenario.totals.search)}</Badge>
                    <Badge>Social: {formatFloat(scenario.totals.social)}</Badge>
                  </div>
                ) : null}

                {params ? (
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 14, background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: 12, color: "#334155" }}>
                    <div style={{ fontWeight: 800, color: "#0f172a" }}>Loaded parameters</div>
                    <div style={{ marginTop: 4 }}>
                      Adstock α — TV: {params.TV.alpha}, Search: {params.Search.alpha}, Social: {params.Social.alpha}
                    </div>
                    <div>
                      Hill — TV(K={params.TV.k}, S={params.TV.s}); Search(K={params.Search.k}, S={params.Search.s}); Social(K={params.Social.k}, S={params.Social.s})
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </Card>

          <Card title="3) Notes">
            <ul style={{ margin: 0, paddingLeft: 18, color: "#475569", fontSize: 13, lineHeight: 1.5 }}>
              <li>Exact notebook alignment: rescale weekly spend profiles, compute adstock, normalize by fixed ref max, apply Hill, update y_pred with deltas.</li>
              <li>CSV parser assumes no quoted commas. If your CSVs can contain quoted fields with commas, tell me and I’ll swap in a robust parser (e.g., PapaParse).</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
