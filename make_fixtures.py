#!/usr/bin/env python3
"""Generate fixtures: dash.html (7 subtle planted bugs), dash_clean.html, checkout_clean.html."""
from pathlib import Path

FX = Path(__file__).parent / "fixtures"

DASH = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Orders</title>
<style>
body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0;background:#f4f5f7;color:#1d2330}
header{background:#1d2330;color:#fff;padding:14px 32px;font-weight:600}
main{max-width:960px;margin:20px auto;padding:0 16px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px}
.card{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.stat .n{font-size:26px;font-weight:700}.stat .l{font-size:13px;color:#6b7487}
.bar{height:10px;background:#e6e8ee;border-radius:5px;margin-top:10px;overflow:hidden}
.bar i{display:block;height:100%;background:#2f6fed;width:%%BARW%%}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:10px 8px;border-bottom:1px solid #e6e8ee;text-align:left}
th.num,td.num{text-align:right}
.tag{padding:2px 8px;border-radius:10px;font-size:12px}
.paid{background:#d9f2e4;color:#1a7f4b}.pend{background:#fdf0d5;color:#8a5a00}.ship{background:#dfe9fd;color:#1f4fb5}
.sub{font-size:12px;color:#6b7487;margin:0 0 8px}
</style></head><body><header>Northwind Goods · Orders</header><main>
<div class="stats">
 <div class="card stat"><div class="n">%%TOTALORD%%</div><div class="l">Total orders</div></div>
 <div class="card stat"><div class="n">2</div><div class="l">%%PENDLABEL%%</div></div>
 <div class="card stat"><div class="l">Fulfillment 80%</div><div class="bar"><i></i></div></div>
</div>
<div class="card"><h2 style="margin:0 0 4px;font-size:18px">Recent orders</h2><p class="sub">Sorted by date, newest first</p>
<table><thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
%%ROWS%%
</tbody></table></div></main></body></html>
"""

def row(oid, cust, date, status, amount, num=True):
    cls = {"Paid": "paid", "Pending": "pend", "Shipped": "ship"}[status]
    td = '<td class="num">' if num else "<td>"
    return f'<tr><td>#{oid}</td><td>{cust}</td><td>{date}</td><td><span class="tag {cls}">{status}</span></td>{td}{amount}</td></tr>'

clean_rows = [
    row(1048, "Maya Chen", "Oct 24, 2026", "Pending", "$128.40"),
    row(1047, "Luis Ortega", "Oct 22, 2026", "Paid", "$54.00"),
    row(1046, "Priya Nair", "Oct 19, 2026", "Shipped", "$212.75"),
    row(1045, "Tom Becker", "Oct 15, 2026", "Pending", "$48.20"),
    row(1044, "Aiko Tanaka", "Oct 12, 2026", "Paid", "$96.10"),
    row(1043, "Sam Wright", "Oct 9, 2026", "Shipped", "$33.95"),
]
bug_rows = [
    clean_rows[0],
    row(1047, "Luis Ortega", "Oct 22, 2026", "Paid", "$54.00", num=False),  # amount not right-aligned
    row(1045, "Tom Becker", "Oct 15, 2026", "Pending", "€48.20"),  # wrong currency
    row(1046, "Priya Nair", "Oct 19, 2026", "Shipped", "$212.75"),  # out of date order (after Oct 15)
    row(1044, "Aiko Tanaka", "2026-10-12", "Paid", "$96.10"),  # date format inconsistent
    clean_rows[5],
]

def dash(rows, barw, total, pend):
    return (DASH.replace("%%ROWS%%", "\n".join(rows)).replace("%%BARW%%", barw)
            .replace("%%TOTALORD%%", total).replace("%%PENDLABEL%%", pend))

(FX / "dash.html").write_text(dash(bug_rows, "30%", "7", "Pending Aproval"))
(FX / "dash_clean.html").write_text(dash(clean_rows, "80%", "6", "Pending approval"))

# Clean twin of the checkout page: every planted bug repaired.
s = (FX / "buggy.html").read_text()
for a, b in [
    (".price { position: absolute; left: 128px; top: 14px; font-weight: 700; }", ".price { margin-left: auto; font-weight: 700; }"),
    ('<input class="shifted"', "<input"),
    ("button { width: 80px;", "button { width: 120px;"),
    ("color: #e3e5ea; background: #eceef2", "color: #5a6275; background: #eceef2"),
    ("[ image failed to load: ceramic-mug.jpg ]", "Mug"),
    ("<span>$59.50</span>", "<span>$69.50</span>"),
]:
    assert a in s, a
    s = s.replace(a, b)
(FX / "checkout_clean.html").write_text(s)
print("fixtures written")
