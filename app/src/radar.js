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
    return [180 + Math.cos(angle) * radius, 155 + Math.sin(angle) * radius];
  };
  const coords = (i, radius) => point(i, radius).map((v) => v.toFixed(2)).join(",");
  const values = view.rows.map((row, i) => row.value === null ? null : coords(i, row.value * .95));
  const complete = values.every((p) => p !== null);
  const summary = view.rows.map((r) => `${r.label} ${r.value === null ? "기록 없음" : `${r.value}%`}`).join(", ");
  return `<span class="radar-heading"><strong>${esc(view.title)}</strong><span class="small muted">${index + 1} / 4</span></span>
    <span class="small muted">최근 7일 · 풀이 횟수 기준</span>
    <svg viewBox="0 0 360 300" role="img" aria-label="${esc(view.title)} 정답률: ${esc(summary)}">
      ${[25, 50, 75, 100].map((v) => `<polygon class="radar-grid" points="${view.rows.map((_, i) => coords(i, v * .95)).join(" ")}"/><text class="radar-scale" x="185" y="${155 - v * .95 + 4}">${v}%</text>`).join("")}
      ${view.rows.map((row, i) => {
        const [x, y] = point(i, 124);
        return `<line class="radar-axis" x1="180" y1="155" x2="${point(i, 95)[0]}" y2="${point(i, 95)[1]}"/><text class="radar-label" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${esc(row.label)}</text>`;
      }).join("")}
      ${complete ? `<polygon class="radar-shape" points="${values.join(" ")}"/>` : view.rows.map((_, i) => values[i] !== null && values[(i + 1) % n] !== null ? `<polyline class="radar-edge" points="${values[i]} ${values[(i + 1) % n]}"/>` : "").join("")}
      ${view.rows.map((row, i) => row.value === null ? "" : `<circle class="radar-point" cx="${point(i, row.value * .95)[0]}" cy="${point(i, row.value * .95)[1]}" r="5"><title>${esc(row.label)} ${row.value}% (${row.ok}/${row.total})</title></circle>`).join("")}
    </svg>
    <span class="radar-values">${view.rows.map((row) => `<span class="radar-value"><span>${esc(row.label)}</span><span>${row.value === null ? '<span class="muted">기록 없음</span>' : `<strong>${row.value}%</strong> <span class="small muted">${row.ok}/${row.total}</span>`}</span></span>`).join("")}</span>
    <span class="radar-footer"><span class="radar-dots" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<i class="${i === index ? "on" : ""}"></i>`).join("")}</span><span class="small muted">탭하여 ${esc(["산업재산권법", "민법개론", "자연과학개론", "전체"][index])} 보기</span></span>`;
}
