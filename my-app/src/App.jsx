import React, { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ResponsiveContainer,
  LineChart,
  Line,
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
 * Interactive MMM Scenario Webpage — EXACT notebook matching
 * ------------------------------------------------------------
 * This version matches your notebook scenario logic exactly:
 * 1) Sliders control TOTAL period spend per channel.
 * 2) Weekly spend SHAPE is preserved and rescaled to hit new totals.
 * 3) Adstock over time uses your exact function:
 *      impact[t] = spend[t] + alpha * impact[t-1]
 * 4) Hill uses fixed normalization anchors from baseline:
 *      x_norm[t] = adstock[t] / ref_max_adstock[channel]
 *      hill[t]   = x_norm^S / (K^S + x_norm^S)
 * 5) Predictions update with delta method (same as notebook):
 *      y_new = y_pred + Σ coef[channel] * (hill_new - hill_baseline)
 *
 * Upload model artifacts:
 * - scenario_inputs.csv (columns: date, tv_2023, tv_2024_2025, search_spend_clean, social_spend_clean)
 * - y_pred.csv (single column y_pred)
 * - scenario_params.json (alpha/k/s, ref_max_adstock, coef)
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
// Small utilities
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

// Very small CSV parser (no external deps). Handles CRLF/LF.
// Assumes no quoted commas.
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text
    .split(/\r?\n/) // FIX: avoid literal newline inside regex
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

function sum(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0);
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
  // fallback: find any key containing substring (handles different dash types)
  const matchKey = Object.keys(params.ref_max_adstock).find((k) => k.includes(fallbackContains));
  const v = matchKey ? params.ref_max_adstock[matchKey] : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// -----------------------------
// Minimal self-tests (run once in browser)
// -----------------------------
function runSelfTests() {
  // parseCsv
  const csv = "a,b\r\n1,2\n3,4\n";
  const p = parseCsv(csv);
  console.assert(p.header.join(",") === "a,b", "parseCsv header failed");
  console.assert(p.rows.length === 2 && p.rows[1][0] === "3", "parseCsv rows failed");

  // adstock
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
// Main component
// -----------------------------
export default function InteractiveMMMScenarioWebpageExact() {
  const [params, setParams] = useState<Params | null>(null);
  const [data, setData] = useState<DataRow[] | null>(null);
  const [yPred, setYPred] = useState<number[] | null>(null);

  const [errors, setErrors] = useState<string[]>([]);

  // Slider totals (k€ if your CSV is k€; otherwise whatever unit your df_model uses)
  const [totals, setTotals] = useState({
    tv_2023: 0,
    tv_2024_2025: 0,
    search: 0,
    social: 0,
  });

  async function loadParams(file: File) {
    try {
      const txt = await readFileAsText(file);
      const obj = JSON.parse(txt);
      setParams(obj);
    } catch (e: any) {
      setErrors((prev) => [...prev, `params: ${e?.message || String(e)}`]);
    }
  }

  async function loadDf(file: File) {
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
      if (missing.length) throw new Error(`df csv missing columns: ${missing.join(", ")}`);

      const rows: DataRow[] = parsed.rows.map((r) => ({
        date: r[idx("date")],
        tv_2023: safeNum(r[idx("tv_2023")]),
        tv_2024_2025: safeNum(r[idx("tv_2024_2025")]),
        search_spend_clean: safeNum(r[idx("search_spend_clean")]),
        social_spend_clean: safeNum(r[idx("social_spend_clean")]),
      }));

      setData(rows);

      // Initialize slider totals to baseline totals
      const tv23 = sum(rows.map((d) => d.tv_2023));
      const tv24 = sum(rows.map((d) => d.tv_2024_2025));
      const se = sum(rows.map((d) => d.search_spend_clean));
      const so = sum(rows.map((d) => d.social_spend_clean));
      setTotals({ tv_2023: tv23, tv_2024_2025: tv24, search: se, social: so });
    } catch (e: any) {
      setErrors((prev) => [...prev, `df csv: ${e?.message || String(e)}`]);
    }
  }

  async function loadYPred(file: File) {
    try {
      const txt = await readFileAsText(file);
      const parsed = parseCsv(txt);

      // Accept either header y_pred, or a single column without header.
      const colIndex = parsed.header.findIndex((h) => h.toLowerCase() === "y_pred");

      if (colIndex === -1) {
        // maybe first row is data (no header) — treat header row as first value row
        const headerAsRow = parsed.header;
        const all = [headerAsRow, ...parsed.rows];
        const vals = all.map((r) => safeNum(r[0]));
        setYPred(vals);
        return;
      }

      const vals = parsed.rows.map((r) => safeNum(r[colIndex]));
      setYPred(vals);
    } catch (e: any) {
      setErrors((prev) => [...prev, `y_pred csv: ${e?.message || String(e)}`]);
    }
  }

  const baseline = useMemo(() => {
    if (!data || !params || !yPred) return null;
    if (yPred.length !== data.length) {
      return { error: `y_pred length (${yPred.length}) must match df rows (${data.length}).` };
    }

    const tv23 = data.map((d) => d.tv_2023);
    const tv24 = data.map((d) => d.tv_2024_2025);
    const se = data.map((d) => d.search_spend_clean);
    const so = data.map((d) => d.social_spend_clean);

    // baseline Hill series for delta method
    const refTv23 = getRef(params, ["TV 2023"], "TV 2023");
    const refTv24 = getRef(
      params,
      ["TV 2024–25", "TV 2024-25", "TV 2024\u201325"],
      "TV 2024"
    );
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

    // Delta update (exact notebook style)
    const yNew = baseline.yPred.map((y, i) => {
      const dTv23 = params.coef.tv_2023_transformed * (tvHill23[i] - baseline.tvHill23[i]);
      const dTv24 = params.coef.tv_2024_2025_transformed * (tvHill24[i] - baseline.tvHill24[i]);
      const dSe = params.coef.search_transformed * (seHill[i] - baseline.seHill[i]);
      const dSo = params.coef.social_transformed * (soHill[i] - baseline.soHill[i]);
      return y + dTv23 + dTv24 + dSe + dSo;
    });

    const totalSales = sum(yNew);

    return {
      yNew,
      totalSales,
      deltaSales: totalSales - baseline.baseSalesTotal,
      deltaPct: baseline.baseSalesTotal > 0 ? (totalSales - baseline.baseSalesTotal) / baseline.baseSalesTotal : 0,
      totals: {
        tv_2023: sum(tv23New),
        tv_2024_2025: sum(tv24New),
        search: sum(seNew),
        social: sum(soNew),
      },
      chart: data.map((d, i) => ({
        date: d.date,
        y_base: baseline.yPred[i],
        y_scn: yNew[i],
      })),
    };
  }, [baseline, params, totals, data]);

  const pieData = useMemo(() => {
    if (!scenario) return [];
    const total =
      scenario.totals.tv_2023 +
      scenario.totals.tv_2024_2025 +
      scenario.totals.search +
      scenario.totals.social;
    if (total <= 0) return [];
    return [
      { name: "TV 2023", value: scenario.totals.tv_2023 },
      { name: "TV 2024–25", value: scenario.totals.tv_2024_2025 },
      { name: "Search", value: scenario.totals.search },
      { name: "Social", value: scenario.totals.social },
    ];
  }, [scenario]);

  const pieTotal = useMemo(() => sum(pieData.map((p) => p.value)), [pieData]);

  const COLORS = ["#0f172a", "#334155", "#64748b", "#94a3b8"]; // neutral palette

  // Slider ranges are derived from baseline totals (if loaded)
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
    const make = (v: number) => ({
      min: 0,
      max: Math.max(1, v * 2.0),
      step: Math.max(0.1, v / 200),
    });
    return {
      tv_2023: make(b.tv_2023),
      tv_2024_2025: make(b.tv_2024_2025),
      search: make(b.search),
      social: make(b.social),
    };
  }, [baseline]);

  function resetToBaseline() {
    if (!baseline || (baseline as any).error) return;
    setTotals({
      tv_2023: baseline.baseTotals.tv_2023,
      tv_2024_2025: baseline.baseTotals.tv_2024_2025,
      search: baseline.baseTotals.search,
      social: baseline.baseTotals.social,
    });
  }

  return (
    <div className="min-h-screen w-full bg-slate-50">
      <div className="mx-auto max-w-6xl p-6">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold text-slate-900">MMM Scenario Planner</h1>
            <p className="text-sm text-slate-600">
              Exact notebook-matching scenario engine (weekly rescale + adstock + fixed-max Hill + delta update).
            </p>
          </div>

          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="md:col-span-2">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-900">Upload model artifacts</div>
                      <div className="text-xs text-slate-600">scenario_inputs.csv, y_pred.csv, scenario_params.json</div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="secondary" onClick={() => setErrors([])}>
                        Clear errors
                      </Button>
                      <Button onClick={resetToBaseline} disabled={!baseline || !!(baseline as any).error}>
                        Reset to baseline
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200">
                      <div className="text-xs font-medium text-slate-900">scenario_inputs.csv</div>
                      <input
                        className="mt-2 block w-full text-xs"
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) loadDf(f);
                        }}
                      />
                      <div className="mt-2 text-[11px] text-slate-500">
                        Must include: date, tv_2023, tv_2024_2025, search_spend_clean, social_spend_clean (from scenario_inputs.csv export)
                      </div>
                    </div>

                    <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200">
                      <div className="text-xs font-medium text-slate-900">y_pred.csv</div>
                      <input
                        className="mt-2 block w-full text-xs"
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) loadYPred(f);
                        }}
                      />
                      <div className="mt-2 text-[11px] text-slate-500">Single column: y_pred</div>
                    </div>

                    <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200">
                      <div className="text-xs font-medium text-slate-900">scenario_params.json</div>
                      <input
                        className="mt-2 block w-full text-xs"
                        type="file"
                        accept="application/json"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) loadParams(f);
                        }}
                      />
                      <div className="mt-2 text-[11px] text-slate-500">alpha/k/s, ref_max_adstock, coef</div>
                    </div>
                  </div>

                  {errors.length > 0 && (
                    <div className="mt-4 rounded-2xl bg-rose-50 p-3 text-sm text-rose-900 ring-1 ring-rose-200">
                      <div className="font-medium">Errors</div>
                      <ul className="mt-2 list-disc pl-5 text-xs">
                        {errors.map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {baseline && (baseline as any).error && (
                    <div className="mt-4 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
                      {(baseline as any).error}
                    </div>
                  )}

                  <Separator className="my-5" />

                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-slate-900">Predicted total sales</div>
                      <div className="text-xs text-slate-600">Scenario vs baseline</div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-semibold text-slate-900">
                        {scenario ? formatInt(scenario.totalSales) : "—"}
                      </div>
                      <div className="text-xs text-slate-600">
                        {scenario
                          ? `${formatInt(scenario.deltaSales)} (${formatFloat(scenario.deltaPct * 100)}%) vs base`
                          : ""}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 h-64 w-full rounded-2xl bg-white p-3 ring-1 ring-slate-200">
                    <div className="mb-2 text-xs font-medium text-slate-900">Weekly prediction (base vs scenario)</div>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={scenario?.chart || []} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} hide />
                        <YAxis tickFormatter={(v) => String(Math.round(v))} />
                        <Tooltip formatter={(value: any) => formatInt(Number(value))} labelFormatter={(l) => `Date: ${l}`} />
                        <Line type="monotone" dataKey="y_base" dot={false} strokeWidth={2} />
                        <Line type="monotone" dataKey="y_scn" dot={false} strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-slate-900">Budget controls</div>
                      <div className="text-xs text-slate-600">Total spend over the full period</div>
                    </div>
                    <div className="text-right text-xs text-slate-600">
                      {scenario
                        ? `Total: ${formatFloat(
                            scenario.totals.tv_2023 +
                              scenario.totals.tv_2024_2025 +
                              scenario.totals.search +
                              scenario.totals.social
                          )}`
                        : "—"}
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col gap-5">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium text-slate-900">TV 2023</div>
                        <div className="text-sm text-slate-700">{formatFloat(totals.tv_2023)}</div>
                      </div>
                      <Slider
                        value={[totals.tv_2023]}
                        min={sliderBounds.tv_2023.min}
                        max={sliderBounds.tv_2023.max}
                        step={sliderBounds.tv_2023.step}
                        onValueChange={(val) => setTotals((p) => ({ ...p, tv_2023: val[0] }))}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium text-slate-900">TV 2024–25</div>
                        <div className="text-sm text-slate-700">{formatFloat(totals.tv_2024_2025)}</div>
                      </div>
                      <Slider
                        value={[totals.tv_2024_2025]}
                        min={sliderBounds.tv_2024_2025.min}
                        max={sliderBounds.tv_2024_2025.max}
                        step={sliderBounds.tv_2024_2025.step}
                        onValueChange={(val) => setTotals((p) => ({ ...p, tv_2024_2025: val[0] }))}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium text-slate-900">Search</div>
                        <div className="text-sm text-slate-700">{formatFloat(totals.search)}</div>
                      </div>
                      <Slider
                        value={[totals.search]}
                        min={sliderBounds.search.min}
                        max={sliderBounds.search.max}
                        step={sliderBounds.search.step}
                        onValueChange={(val) => setTotals((p) => ({ ...p, search: val[0] }))}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium text-slate-900">Social</div>
                        <div className="text-sm text-slate-700">{formatFloat(totals.social)}</div>
                      </div>
                      <Slider
                        value={[totals.social]}
                        min={sliderBounds.social.min}
                        max={sliderBounds.social.max}
                        step={sliderBounds.social.step}
                        onValueChange={(val) => setTotals((p) => ({ ...p, social: val[0] }))}
                      />
                    </div>
                  </div>

                  <Separator className="my-5" />

                  <div className="text-sm font-medium text-slate-900">Budget distribution</div>
                  <div className="mt-1 text-xs text-slate-600">Pie chart updates in real time</div>

                  <div className="mt-3 h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={70}
                          label={(entry: any) =>
                            pieTotal > 0
                              ? `${entry.name}: ${Math.round((entry.value / pieTotal) * 100)}%`
                              : entry.name
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

                  <div className="mt-2 flex flex-wrap gap-2">
                    {scenario && (
                      <>
                        <Badge variant="secondary" className="rounded-xl">
                          TV 2023: {formatFloat(scenario.totals.tv_2023)}
                        </Badge>
                        <Badge variant="secondary" className="rounded-xl">
                          TV 2024–25: {formatFloat(scenario.totals.tv_2024_2025)}
                        </Badge>
                        <Badge variant="secondary" className="rounded-xl">
                          Search: {formatFloat(scenario.totals.search)}
                        </Badge>
                        <Badge variant="secondary" className="rounded-xl">
                          Social: {formatFloat(scenario.totals.social)}
                        </Badge>
                      </>
                    )}
                  </div>

                  {params && (
                    <div className="mt-4 rounded-2xl bg-slate-50 p-3 text-[11px] text-slate-600 ring-1 ring-slate-200">
                      <div className="font-medium text-slate-900">Loaded model parameters</div>
                      <div className="mt-1">
                        Adstock alphas — TV: {params.TV.alpha}, Search: {params.Search.alpha}, Social: {params.Social.alpha}
                      </div>
                      <div>
                        Hill — TV(K={params.TV.k}, S={params.TV.s}); Search(K={params.Search.k}, S={params.Search.s});
                        Social(K={params.Social.k}, S={params.Social.s})
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <Separator className="my-5" />

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
                  <div className="text-sm font-medium text-slate-900">Scenario summary</div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
                      <div className="text-xs text-slate-600">Baseline sales (sum y_pred)</div>
                      <div className="mt-1 font-semibold">
                        {baseline && !(baseline as any).error ? formatInt(baseline.baseSalesTotal) : "—"}
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
                      <div className="text-xs text-slate-600">Scenario sales</div>
                      <div className="mt-1 font-semibold">{scenario ? formatInt(scenario.totalSales) : "—"}</div>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
                      <div className="text-xs text-slate-600">Delta sales</div>
                      <div className="mt-1 font-semibold">{scenario ? formatInt(scenario.deltaSales) : "—"}</div>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
                      <div className="text-xs text-slate-600">Delta %</div>
                      <div className="mt-1 font-semibold">{scenario ? `${formatFloat(scenario.deltaPct * 100)}%` : "—"}</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
                  <div className="text-sm font-medium text-slate-900">Notes</div>
                  <ul className="mt-3 list-disc pl-5 text-sm text-slate-600">
                    <li>Matches the notebook scenario engine by rescaling weekly spend shapes to hit channel totals.</li>
                    <li>Uses fixed Hill anchors (baseline max adstock) for normalization.</li>
                    <li>Uses the delta method on y_pred to avoid recomputing the full design matrix.</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
