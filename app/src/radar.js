import { SUBJECTS, addDays, dayKey, esc } from "./logic.js";

export const RADAR_PARTS = {
  산업재산권법: ["특허법", "실용신안법", "상표법", "디자인보호법", "조약"],
  민법개론: ["민법총칙", "물권법", "채권총론", "채권각론"],
  자연과학개론: ["물리", "화학", "생물", "지구과학"],
};

export function radarViews(log, byId, today) {
  const start = addDays(today, -6);
  const views = [
    { title: "전체", labels: SUBJECTS },
    ...SUBJECTS.map((subject) => ({ title: subject, labels: RADAR_PARTS[subject] })),
  ].map((view) => ({ ...view, rows: view.labels.map((label) => ({ label, ok: 0, total: 0 })) }));
  for (const attempt of log) {
    const day = dayKey(attempt.t);
    if (day < start || day > today) continue;
    const q = byId.get(attempt.id);
    const subjectIndex = SUBJECTS.indexOf(q?.subject);
    if (subjectIndex < 0) continue;
    const rows = [views[0].rows[subjectIndex], views[subjectIndex + 1].rows.find((row) => row.label === q.topic)];
    for (const row of rows) {
      if (!row) continue;
      row.total++;
      if (attempt.ok) row.ok++;
    }
  }
  return views.map((view) => ({ ...view, rows: view.rows.map((row) => ({ ...row, value: row.total ? Math.round(row.ok / row.total * 100) : null })) }));
}

export function radarFace(view, index) {
  const n = view.rows.length;
  const point = (i, radius) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
    return [200 + Math.cos(angle) * radius, 170 + Math.sin(angle) * radius];
  };
  const coords = (i, radius) => point(i, radius).map((v) => v.toFixed(2)).join(",");
  const values = view.rows.map((row, i) => row.value === null ? null : coords(i, row.value * 1.04));
  const complete = values.every((p) => p !== null);
  const summary = view.rows.map((r) => `${r.label} ${r.value === null ? "기록 없음" : `${r.value}%`}`).join(", ");
  const gradient = `radar-fill-${index}`;
  return `<span class="radar-heading"><strong>${esc(view.title)}</strong><span class="small muted">${complete ? "학습 균형" : "기록을 더 쌓아주세요"}</span></span>
    <svg viewBox="0 0 400 340" role="img" aria-label="${esc(view.title)} 정답률: ${esc(summary)}">
      <defs><linearGradient id="${gradient}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#8DCBEA" stop-opacity=".65"/><stop offset="100%" stop-color="#CAE5F4" stop-opacity=".22"/></linearGradient></defs>
      <polygon class="radar-backdrop" points="${view.rows.map((_, i) => coords(i, 104)).join(" ")}"/>
      ${[1/3, 2/3, 1].map((v) => `<polygon class="radar-grid" points="${view.rows.map((_, i) => coords(i, v * 104)).join(" ")}"/>`).join("")}
      ${view.rows.map((row, i) => {
        const [x, y] = point(i, 136);
        return `<line class="radar-axis" x1="200" y1="170" x2="${point(i, 104)[0]}" y2="${point(i, 104)[1]}"/><text class="radar-label" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${esc(row.label)}</text>`;
      }).join("")}
      ${complete ? `<polygon class="radar-shape" style="fill:url(#${gradient})" points="${values.join(" ")}"/>` : ""}
      ${view.rows.map((row, i) => row.value === null ? "" : `<circle class="radar-point" cx="${point(i, row.value * 1.04)[0]}" cy="${point(i, row.value * 1.04)[1]}" r="4.5"><title>${esc(row.label)} ${row.value}% (${row.ok}/${row.total})</title></circle>`).join("")}
    </svg>
    <span class="radar-values">${view.rows.map((row) => `<span class="radar-value"><span class="radar-value-name">${esc(row.label)}</span><span class="radar-result">${row.value === null ? '<span class="radar-missing">기록 없음</span>' : `<strong>${row.value}<small>%</small></strong><span class="radar-sample">${row.total}회 중 ${row.ok}회 정답</span>`}</span></span>`).join("")}</span>
    `;
}
