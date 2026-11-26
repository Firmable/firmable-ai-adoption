/* AI adoption landscape explorer. Plain browser JavaScript: no libraries, no network calls.
   Reads the embedded data with JSON.parse and builds every element with createElement and textContent. */
(function () {
  "use strict";
  var root = document.getElementById("explorer");
  var src = document.getElementById("explorer-data");
  if (!root || !src) return;
  var data = JSON.parse(src.textContent);
  var blocks = [data.cohort].concat(data.groups || []);
  var dims = data.dimensions || [];
  var state = { group: 0, area: "overall", facet: "level", value: "", company: null };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function shown(v) { return v === null || v === undefined ? "not returned" : String(v); }
  function pctText(v) { return v === null || v === undefined ? "-" : String(v) + "%"; }

  function select(labelText, options, current, onChange) {
    var label = el("label", null, labelText);
    var s = el("select");
    options.forEach(function (o) {
      var opt = el("option", null, o[1]);
      opt.value = o[0];
      if (o[0] === current) opt.selected = true;
      s.appendChild(opt);
    });
    s.addEventListener("change", function () { onChange(s.value); });
    label.appendChild(s);
    return label;
  }

  function distOf(b) {
    if (state.area === "overall") return b.overall_level;
    if (state.area === "momentum") return b.momentum;
    return b.dimensions[state.area][state.facet];
  }
  function valueOf(ai) {
    if (!ai) return null;
    if (state.area === "overall") return ai.overall_level;
    if (state.area === "momentum") return ai.momentum_label;
    var d = (ai.dimensions || {})[state.area];
    return d ? d[state.facet] : null;
  }
  function areaName() {
    if (state.area === "overall") return "overall level";
    if (state.area === "momentum") return "momentum label";
    return state.area + " " + state.facet;
  }
  function inGroup(c, b) { return state.group === 0 || c.group === b.group; }

  function table(headers, rows) {
    var wrap = el("div", "scroll");
    var t = el("table");
    var thead = el("thead");
    var tr = el("tr");
    headers.forEach(function (h) { tr.appendChild(el("th", null, h)); });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = el("tbody");
    rows.forEach(function (r) {
      var row = el("tr");
      r.forEach(function (c) {
        var td = el("td");
        if (c && c.nodeType === 1) td.appendChild(c); else td.textContent = shown(c);
        row.appendChild(td);
      });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  function counts(b) {
    var p = el("p", "muted");
    p.textContent = b.companies + " compan(ies) in this group: " + b.asked + " asked, " + b.found + " found, " +
      b.not_found + " not found, " + b.error + " error, " + (b.not_processed + b.invalid_input) + " not sent.";
    return p;
  }

  function bars(dist) {
    var box = el("div");
    if (!dist.values.length) { box.appendChild(el("p", null, "No value was returned for this measure.")); return box; }
    if (dist.too_few_answers) {
      box.appendChild(el("div", "note t-unknown", "Too few answers to compare: " + dist.answered +
        " answered, fewer than " + data.min_answered + ". Counts are shown without shares."));
    }
    dist.values.forEach(function (v) {
      var row = el("div", "ex-bar");
      row.appendChild(el("div", null, v.value));
      var track = el("div", "ex-track");
      var fill = el("div", "ex-fill");
      fill.style.width = (dist.too_few_answers || !dist.answered ? 0 : (v.count * 100 / dist.answered)) + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("div", null, dist.too_few_answers ? v.count + " of " + dist.answered
        : v.count + " of " + dist.answered + " (" + pctText(v.share_pct) + ")"));
      box.appendChild(row);
    });
    box.appendChild(el("p", "muted", "No value: " + dist.no_value + " (" + pctText(dist.no_value_share_pct) +
      "). Not found and no level returned are not no adoption."));
    return box;
  }

  function compareTable() {
    var rows = blocks.map(function (b) {
      var d = distOf(b);
      var vals = d.values.map(function (v) { return v.value + " " + v.count; }).join("; ");
      return [b.group, b.companies, d.answered, vals || "none", d.no_value, d.too_few_answers ? "too few answers to compare" : ""];
    });
    return table(["Group", "Companies", "Answered", "Counts", "No value", "Note"], rows);
  }

  function drilldown(c) {
    var panel = el("div", "ex-panel");
    panel.appendChild(el("h3", null, c.name));
    panel.appendChild(el("p", "muted", "Row " + c.row_id + " · " + c.status.replace(/_/g, " ") +
      (c.group !== null && c.group !== undefined ? " · group " + c.group : "")));
    panel.appendChild(el("p", null, c.status_reason));
    if (c.same_company_as) panel.appendChild(el("p", "muted", "Same Firmable company as row " + c.same_company_as + "."));
    var ai = c.ai;
    if (!ai) {
      if (c.status === "not_found") panel.appendChild(el("div", "note t-unknown", "Firmable has no AI Adoption data for this company. This is not evidence of no adoption."));
      return panel;
    }
    panel.appendChild(table(["Field", "Value"], [
      ["Firmable ID", ai.firmable_id], ["Overall level", ai.overall_level], ["Explanation", ai.explanation],
      ["Momentum", ai.momentum_label], ["Industry group", ai.industry_group], ["Size band", ai.size_band],
      ["Country", ai.country], ["Data as of", ai.as_of], ["Framework version", ai.framework_version]]));
    panel.appendChild(el("h3", null, "Momentum signals"));
    if (ai.momentum_signals && ai.momentum_signals.length) {
      panel.appendChild(table(["Kind", "Count", "Latest"], ai.momentum_signals.map(function (s) {
        return [s.kind, s.count, s.latest];
      })));
    } else {
      panel.appendChild(el("p", "muted", "No momentum signals returned."));
    }
    panel.appendChild(el("h3", null, "Areas"));
    panel.appendChild(table(["Area", "Level", "Observability", "Counts toward overall", "Headline", "Evidence held"],
      dims.map(function (d) {
        var x = (ai.dimensions || {})[d] || {};
        var held = ai.evidence_available ? ai.evidence_available[d] : null;
        var cto = x.counts_toward_overall === true ? "yes" : x.counts_toward_overall === false ? "no" : null;
        return [d, x.level, x.observability, cto, x.headline, held];
      })));
    if (c.evidence) {
      var areas = Object.keys(c.evidence);
      panel.appendChild(el("h3", null, "Evidence returned"));
      if (areas.length) {
        panel.appendChild(table(["Area", "Items held", "Items returned", "Qualifying", "Not qualifying", "Truncated"],
          areas.map(function (a) {
            var e = c.evidence[a];
            return [a, e.item_count, e.items_returned, e.qualifying, e.not_qualifying, e.truncated ? "yes" : "no"];
          })));
      } else {
        panel.appendChild(el("p", "muted", "No evidence was returned for this company."));
      }
    }
    return panel;
  }

  function companyList(b) {
    var dist = distOf(b);
    var box = el("div");
    var opts = [["", "Any value"]].concat(dist.values.map(function (v) { return [v.value, v.value]; }));
    opts.push(["__none__", "No value"]);
    var ctl = el("div", "ex-controls");
    ctl.appendChild(select("Filter by " + areaName(), opts, state.value, function (v) { state.value = v; draw(); }));
    box.appendChild(ctl);
    var list = (data.companies || []).filter(function (c) {
      if (!inGroup(c, b)) return false;
      var v = valueOf(c.ai);
      if (state.value === "") return true;
      if (state.value === "__none__") return v === null || v === undefined || v === "";
      return v === state.value;
    });
    var rows = list.map(function (c) {
      var btn = el("button", null, c.name);
      btn.type = "button";
      btn.addEventListener("click", function () { state.company = c.row_id; draw(); });
      return [btn, c.status.replace(/_/g, " "), valueOf(c.ai), c.group];
    });
    var wrap = el("div", "ex-list");
    wrap.appendChild(el("p", "muted", list.length + " compan(ies) shown."));
    wrap.appendChild(table(["Company", "Status", areaName(), "Group"], rows));
    box.appendChild(wrap);
    var chosen = list.filter(function (c) { return c.row_id === state.company; })[0];
    if (chosen) box.appendChild(drilldown(chosen));
    return box;
  }

  function draw() {
    clear(root);
    var b = blocks[state.group] || blocks[0];
    var ctl = el("div", "ex-controls");
    ctl.appendChild(select("Group", blocks.map(function (x, i) { return [String(i), x.group + " (" + x.companies + ")"]; }),
      String(state.group), function (v) { state.group = Number(v); state.value = ""; state.company = null; draw(); }));
    var areaOpts = [["overall", "Overall level"]].concat(dims.map(function (d) { return [d, d]; }));
    areaOpts.push(["momentum", "Momentum"]);
    ctl.appendChild(select("Measure", areaOpts, state.area, function (v) { state.area = v; state.value = ""; draw(); }));
    if (state.area !== "overall" && state.area !== "momentum") {
      ctl.appendChild(select("Show", [["level", "Level"], ["observability", "Observability"]], state.facet,
        function (v) { state.facet = v; state.value = ""; draw(); }));
    }
    root.appendChild(ctl);
    root.appendChild(el("h3", null, b.group + ": " + areaName()));
    root.appendChild(counts(b));
    root.appendChild(bars(distOf(b)));
    if (blocks.length > 1) {
      root.appendChild(el("h3", null, "All groups: " + areaName()));
      root.appendChild(compareTable());
    }
    root.appendChild(el("h3", null, "Companies"));
    root.appendChild(companyList(b));
    root.appendChild(el("p", "muted", "Counts describe this cohort only. Levels are shown as returned and are not ranked."));
  }

  draw();
})();
