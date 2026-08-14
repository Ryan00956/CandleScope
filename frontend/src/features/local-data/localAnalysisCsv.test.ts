import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEventCsvText,
  prepareEventCsv,
  suggestEventCsvMapping,
} from "./localAnalysisCsv.js";

test("event CSV parser supports BOM, quoted commas, and quoted newlines", () => {
  const document = parseEventCsvText(
    "\uFEFFtime,title,note\r\n"
    + "1704067200,Entry,\"first line, with comma\nsecond line\"\r\n",
  );

  assert.deepEqual(document.headers, ["time", "title", "note"]);
  assert.equal(document.rows.length, 1);
  assert.equal(document.rows[0]?.values.note, "first line, with comma\nsecond line");
  assert.deepEqual(suggestEventCsvMapping(document.headers), {
    time: "time",
    price: null,
    kind: null,
    label: "title",
    note: "note",
    color: null,
  });
});

test("event CSV parser rejects text after a closing quote", () => {
  assert.throws(
    () => parseEventCsvText("time,title\n1704067200,\"entry\"oops\n"),
    /引号字段/,
  );
});

test("event CSV preparation is generic and retains every unmapped column", () => {
  const document = parseEventCsvText(
    "timestamp,price,type,title,model_score\n"
    + "1704067200,42000,entry,Model entry,0.83\n"
    + "1704067260,42100,rebalance,Custom event,0.51\n",
  );
  const prepared = prepareEventCsv(document, {
    time: "timestamp",
    price: "price",
    kind: "type",
    label: "title",
    note: null,
    color: null,
  }, "auto", "note");

  assert.equal(prepared.rejected.length, 0);
  assert.equal(prepared.accepted[0]?.inputTimeMs, 1_704_067_200_000);
  assert.equal(prepared.accepted[0]?.draft.kind, "entry");
  assert.equal(prepared.accepted[0]?.extra.model_score, "0.83");
  assert.equal(prepared.accepted[1]?.draft.kind, "custom");
  assert.equal(prepared.accepted[1]?.extra.original_kind, "rebalance");
});

test("event CSV preparation rejects timezone guessing and invalid rows separately", () => {
  const document = parseEventCsvText(
    "time,price,color\n"
    + "2026-01-01T12:00:00,42,#22c55e\n"
    + "2026-01-01T12:00:00Z,bad,#22c55e\n"
    + "2026-01-01T12:00:00Z,42,green\n"
    + "2026-01-01T12:00:00+08:00,42,#22c55e\n",
  );
  const prepared = prepareEventCsv(document, {
    time: "time",
    price: "price",
    kind: null,
    label: null,
    note: null,
    color: "color",
  }, "iso", "signal");

  assert.equal(prepared.accepted.length, 1);
  assert.equal(prepared.rejected.length, 3);
  assert.match(prepared.rejected[0]?.reason ?? "", /时区/);
  assert.match(prepared.rejected[1]?.reason ?? "", /价格/);
  assert.match(prepared.rejected[2]?.reason ?? "", /#RRGGBB/);
});
