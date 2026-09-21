#!/usr/bin/env python3
"""auditrail cross-implementation oracle (stdlib only, integer money).

An independent Python implementation of the accounting rules, used to check the JavaScript
implementation to the token and the nanodollar on every generated fixture. It shares no code
with the JavaScript side on purpose.

Rules implemented (see INTERFACES.md for the full text):
  discovery   recursive sorted walk; *.jsonl, *.jsonl.superseded-*, .orphaned-*.jsonl; four path shapes
  reading     split bytes on 0x0A only, strip one trailing 0x0D, count trailing partial lines
  A1 to A4    global dedup by message.id (else requestId, else uuid); requestId conflict split;
              keep the max-output line with ties by file depth, relative path, root, later line
  A5          complete iff stop_reason is non-null or usage has a speed key
  A7          TTL split with integer rescale; absent split prices all writes at 5m (ttlEstimated)
  A8          bill each usage.iterations entry at its own model, skip zero-output non-final entries
  A9 to A13   exact normalized model ids, fast rates, US geo 1.1x as rate * 11 / 10, web search
  A15         drop <synthetic> lines; 429s feed rate-limit episodes
  A20 to A25  sessions, active time (union per session, uuid dedup), agent time per file,
              work blocks, prompts, interrupts, active days, streak, peak hour
  A30         tool use dedup by id, pairing across files, statuses
  A33         integer nanodollars: tokens * rate in milli-dollars per million tokens

Usage: python ar_oracle.py <projects root> [--tz UTC] [--idle-minutes 15]
Prints one JSON object of aggregates. Money values are strings of integer nanodollars.
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

# milli-dollars per million tokens: input, output, 5m write, 1h write, cache read, US geo eligible
RATES = {
    'claude-fable-5-1': (10000, 50000, 12500, 20000, 250, True),
    'claude-fable-5': (10000, 50000, 12500, 20000, 1000, True),
    'claude-opus-5': (5000, 25000, 6250, 10000, 500, True),
    'claude-opus-4-8': (5000, 25000, 6250, 10000, 500, True),
    'claude-opus-4-7': (5000, 25000, 6250, 10000, 500, True),
    'claude-opus-4-6': (5000, 25000, 6250, 10000, 500, True),
    'claude-opus-4-5': (5000, 25000, 6250, 10000, 500, False),
    'claude-sonnet-5': (2000, 10000, 2500, 4000, 200, True),
    'claude-sonnet-4-6': (3000, 15000, 3750, 6000, 300, True),
    'claude-sonnet-4-5': (3000, 15000, 3750, 6000, 300, False),
    'claude-haiku-4-5': (1000, 5000, 1250, 2000, 100, False),
}
FAST = {
    'claude-opus-5': (10000, 50000, 12500, 20000, 1000),
    'claude-opus-4-8': (10000, 50000, 12500, 20000, 1000),
}
WEB_SEARCH_NANO = 10_000_000
DEPTH = {'main': 0, 'subagent': 1, 'workflow_agent': 2, 'workflow_journal': 3}
SHELL = ('Bash', 'PowerShell')
TOKEN_KEYS = ('input', 'output', 'cw5m', 'cw1h', 'cacheRead')
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
WHITESPACE = ' \t\r\n' + chr(0xFEFF)  # JSON whitespace plus a stray byte order mark


def norm_model(m):
    m = re.sub(r'\[[^\]]*\]$', '', m or '')
    return re.sub(r'-\d{8}$', '', m)


def u16(s):
    """Sort key matching JavaScript string comparison (UTF-16 code units)."""
    return s.encode('utf-16-be')


def classify(rel):
    parts = rel.split('/')
    name = parts[-1]
    if name.endswith('.jsonl.zst'):
        return None
    ok = name.endswith('.jsonl') or re.search(r'\.jsonl\.superseded-', name)
    if not ok:
        return None
    if len(parts) == 2:
        return 'main'
    if len(parts) == 4 and parts[2] == 'subagents':
        return 'subagent'
    if len(parts) == 6 and parts[2] == 'subagents' and parts[3] == 'workflows':
        stem = re.sub(r'^\.orphaned-', '', name)
        if stem.startswith('agent-'):
            return 'workflow_agent'
        # Observed on disk: workflows/<run>/journal.jsonl. The design text said <run>/<run>.jsonl; accept both.
        if stem.split('.jsonl')[0] in ('journal', parts[4]):
            return 'workflow_journal'
    return None


def walk(root):
    out = []
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for f in sorted(fn):
            rel = os.path.relpath(os.path.join(dp, f), root).replace(os.sep, '/')
            out.append(rel)
    return sorted(out, key=u16)


def parse_ts(s):
    if not isinstance(s, str):
        return None
    try:
        dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    d = dt - EPOCH  # integer milliseconds, sub-millisecond digits truncated like JavaScript Date.parse
    return d.days * 86_400_000 + d.seconds * 1000 + d.microseconds // 1000


def resolve_ttl(u):
    total = u.get('cache_creation_input_tokens') or 0
    if total == 0:
        return 0, 0, False
    cc = u.get('cache_creation')
    if not isinstance(cc, dict):
        return total, 0, True
    s5 = cc.get('ephemeral_5m_input_tokens') or 0
    s1 = cc.get('ephemeral_1h_input_tokens') or 0
    if s5 + s1 == total:
        return s5, s1, False
    if s5 + s1 == 0:
        return total, 0, True
    w5 = total * s5 // (s5 + s1)
    return w5, total - w5, False


def parts_of(model, u, all_5m=False):
    its = u.get('iterations')
    def one(m, x):
        w5, w1, est = resolve_ttl(x)
        if all_5m:
            w5, w1 = w5 + w1, 0
        return {'model': norm_model(m), 'input': x.get('input_tokens') or 0, 'output': x.get('output_tokens') or 0,
                'cw5m': w5, 'cw1h': w1, 'cacheRead': x.get('cache_read_input_tokens') or 0, 'est': est}
    if not isinstance(its, list) or len(its) <= 1:
        return [one(model, u)]
    out = []
    for i, e in enumerate(its):
        if not (e.get('output_tokens') or 0) and i != len(its) - 1:
            continue
        out.append(one(e.get('model') or model, e))
    return out


def price_part(p, speed, geo):
    r = RATES.get(p['model'])
    if r is None:
        return None
    rates = list(r[:5])
    if speed == 'fast' and p['model'] in FAST:
        rates = list(FAST[p['model']])
    if geo == 'us' and r[5]:
        rates = [x * 11 // 10 for x in rates]
    b = {'input': p['input'] * rates[0], 'output': p['output'] * rates[1], 'cw5m': p['cw5m'] * rates[2],
         'cw1h': p['cw1h'] * rates[3], 'cacheRead': p['cacheRead'] * rates[4]}
    return b


def response_value(model, u, all_5m=False):
    """Returns (priced, value_nano, buckets, parts)."""
    speed, geo = u.get('speed'), u.get('inference_geo')
    parts = parts_of(model, u, all_5m)
    total, priced = 0, True
    buckets = {k: 0 for k in TOKEN_KEYS}
    buckets['webSearch'] = 0
    for p in parts:
        b = price_part(p, speed, geo)
        p['value'] = None if b is None else sum(b.values())
        if b is None:
            priced = False
            continue
        for k, v in b.items():
            buckets[k] += v
            total += v
    stu = u.get('server_tool_use') if isinstance(u.get('server_tool_use'), dict) else {}
    ws = (stu.get('web_search_requests') or 0) * WEB_SEARCH_NANO
    buckets['webSearch'] += ws
    total += ws
    return priced, total, buckets, parts


def local_parts(ms, tz):
    dt = datetime.fromtimestamp(ms / 1000, tz)
    return dt.strftime('%Y-%m-%d'), dt.hour, dt.weekday()


def resolve_tz(name):
    if name == 'UTC':
        return timezone.utc
    m = re.fullmatch(r'([+-])(\d{2}):(\d{2})', name)
    if m:
        sign = 1 if m.group(1) == '+' else -1
        return timezone(sign * timedelta(hours=int(m.group(2)), minutes=int(m.group(3))))
    from zoneinfo import ZoneInfo  # may fail on systems without tzdata
    return ZoneInfo(name)


def scan(root, tz_name='UTC', idle_minutes=15):
    tz = resolve_tz(tz_name)
    idle_ms = idle_minutes * 60 * 1000
    files = []
    for rel in walk(root):
        cls = classify(rel)
        if cls is not None:
            files.append({'idx': len(files), 'rel': rel, 'cls': cls, 'depth': DEPTH[cls]})
    scan_stats = {'files': {c: 0 for c in DEPTH}, 'linesByClass': {c: 0 for c in DEPTH}, 'recordsByClass': {c: 0 for c in DEPTH},
                  'parseErrors': 0, 'trailingPartial': 0, 'oversizeLines': 0}
    obs, uses, results, activity, prompts, interrupts = [], {}, {}, {}, {}, {}
    no_uuid_activity = []
    synthetic, synth429, windows = 0, [], set()
    synth429_seen = set()
    workflows = {'launched': 0, 'started': 0, 'result': 0, 'failed': 0}
    dup_tool_ids = 0

    def file_order(fi, ln):
        f = files[fi]
        return (f['depth'], u16(f['rel']), 0, -ln)

    for f in files:
        fi, cls = f['idx'], f['cls']
        scan_stats['files'][cls] += 1
        with open(os.path.join(root, f['rel']), 'rb') as fh:
            data = fh.read()
        segs = data.split(b'\n')
        terminated_last = data.endswith(b'\n') or len(data) == 0
        if terminated_last:
            segs = segs[:-1]
        for i, seg in enumerate(segs):
            ln = i + 1
            scan_stats['linesByClass'][cls] += 1
            terminated = terminated_last or i < len(segs) - 1
            if seg.endswith(b'\r'):
                seg = seg[:-1]
            text = seg.decode('utf-8', errors='replace')
            if not text.strip(WHITESPACE):
                continue
            try:
                e = json.loads(text)
            except ValueError:
                if terminated:
                    scan_stats['parseErrors'] += 1
                else:
                    scan_stats['trailingPartial'] += 1
                continue
            if not isinstance(e, dict):
                continue
            scan_stats['recordsByClass'][cls] += 1
            t = e.get('type')
            if cls == 'workflow_journal':
                if t in workflows:
                    workflows[t] += 1
                continue
            sid = e.get('sessionId')
            ts = parse_ts(e.get('timestamp'))
            if t in ('user', 'assistant') and ts is not None:
                rec = {'sid': sid, 'ts': ts, 'fi': fi, 'ln': ln, 'cls': cls}
                uid = e.get('uuid')
                if uid:
                    prev = activity.get(uid)
                    if prev is None or file_order(fi, ln) < file_order(prev['fi'], prev['ln']):
                        activity[uid] = rec
                else:
                    no_uuid_activity.append(rec)
            m = e.get('message') if isinstance(e.get('message'), dict) else {}
            content = m.get('content')
            blocks = content if isinstance(content, list) else []
            if t == 'user':
                for b in blocks:
                    if isinstance(b, dict) and b.get('type') == 'tool_result':
                        tid = b.get('tool_use_id')
                        r = {'err': bool(b.get('is_error')), 'denied': 'toolDenialKind' in e, 'fi': fi, 'ln': ln}
                        prev = results.get(tid)
                        if prev is None or file_order(fi, ln) < file_order(prev['fi'], prev['ln']):
                            results[tid] = r
                if (not e.get('isSidechain') and not e.get('isMeta') and not e.get('isCompactSummary')
                        and e.get('promptSource') != 'system' and ts is not None):
                    txt = None
                    if isinstance(content, str):
                        txt = content
                    elif isinstance(content, list):
                        has_result = any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in content)
                        texts = [b.get('text') for b in content if isinstance(b, dict) and b.get('type') == 'text']
                        if texts and not has_result:
                            txt = texts[0] if isinstance(texts[0], str) else ''
                    if txt is not None:
                        key = e.get('uuid') or f'line:{fi}:{ln}'
                        target = interrupts if txt.startswith('[Request interrupted by user') else prompts
                        target[key] = ts
                continue
            if t != 'assistant':
                continue
            q = e.get('quotaLimits')
            if isinstance(q, dict) and q.get('status') == 'rejected' and q.get('resetsAt') is not None:
                windows.add(q.get('resetsAt'))
            if m.get('model') == '<synthetic>':
                synthetic += 1
                # a duplicate copy of a file repeats the same 429 line: count it once per (session, ts)
                if e.get('apiErrorStatus') == 429 and ts is not None and (e.get('sessionId'), ts) not in synth429_seen:
                    synth429_seen.add((e.get('sessionId'), ts))
                    synth429.append(ts)
                continue
            for b in blocks:
                if isinstance(b, dict) and b.get('type') == 'tool_use':
                    tid = b.get('id')
                    inp = b.get('input') if isinstance(b.get('input'), dict) else {}
                    rec = {'name': b.get('name'), 'fi': fi, 'ln': ln, 'inp_new': inp.get('new_string'), 'inp_edits': inp.get('edits'),
                           'inp_content': inp.get('content')}
                    prev = uses.get(tid)
                    if prev is not None:
                        dup_tool_ids += 1
                    if prev is None or file_order(fi, ln) < file_order(prev['fi'], prev['ln']):
                        uses[tid] = rec
            u = m.get('usage')
            if not isinstance(u, dict):
                continue
            key = m.get('id') or e.get('requestId') or e.get('uuid') or f'line:{fi}:{ln}'
            obs.append({'key': key, 'fromId': bool(m.get('id')), 'rid': e.get('requestId') or '', 'out': u.get('output_tokens') or 0,
                        'fi': fi, 'ln': ln, 'u': u, 'model': m.get('model'), 'sid': sid, 'side': bool(e.get('isSidechain')), 'ts': ts,
                        'final': m.get('stop_reason') is not None or 'speed' in u})

    # Dedup (A1 to A4)
    groups, conflicts = {}, 0
    for o in obs:
        groups.setdefault(o['key'], []).append(o)
    final_groups = {}
    for key, g in groups.items():
        rids = sorted({o['rid'] for o in g if o['rid']}, key=u16)
        if g[0]['fromId'] and len(rids) > 1:
            conflicts += 1
            for o in g:
                sub = o['rid'] or rids[0]
                final_groups.setdefault(key + '|' + sub, []).append(o)
        else:
            final_groups[key] = g

    def keep_order(o):
        return (-o['out'],) + file_order(o['fi'], o['ln'])

    responses, violations, forked = [], 0, 0
    for key, g in final_groups.items():
        kept = min(g, key=keep_order)
        sig = {((o['u'].get('input_tokens') or 0), (o['u'].get('cache_creation_input_tokens') or 0), (o['u'].get('cache_read_input_tokens') or 0)) for o in g}
        if len(sig) > 1:
            violations += 1
        if len({o['fi'] for o in g}) > 1:
            forked += 1
        priced, value, buckets, parts = response_value(kept['model'], kept['u'])
        responses.append({'key': key, 'kept': kept, 'priced': priced, 'value': value, 'buckets': buckets, 'parts': parts,
                          'cls': files[kept['fi']]['cls'], 'complete': kept['final']})

    tokens = {k: 0 for k in TOKEN_KEYS}
    buckets_total = {k: 0 for k in TOKEN_KEYS + ('webSearch',)}
    by_class = {'main': 0, 'subagent': 0, 'workflow_agent': 0}
    by_model, unpriced = {}, {}
    total = priced_tokens = all_tokens = 0
    fast = geo_us = ttl_est = ws_req = 0
    per_response = {}
    side_value = 0
    for r in responses:
        u = r['kept']['u']
        for p in r['parts']:
            n = sum(p[k] for k in TOKEN_KEYS)
            all_tokens += n
            for k in TOKEN_KEYS:
                tokens[k] += p[k]
            if p['value'] is None:
                e = unpriced.setdefault(p['model'], {'model': p['model'], 'responses': 0, 'tokens': 0})
                e['tokens'] += n
            else:
                priced_tokens += n
                by_model[p['model']] = by_model.get(p['model'], 0) + p['value']
        for p in r['parts']:
            if p['value'] is None:
                unpriced[p['model']]['responses'] += 1
                break
        total += r['value']
        for k, v in r['buckets'].items():
            buckets_total[k] += v
        by_class[r['cls']] = by_class.get(r['cls'], 0) + r['value']
        if r['kept']['side']:
            side_value += r['value']
        per_response[r['key']] = str(r['value']) if r['priced'] else None
        top = norm_model(r['kept']['model'])
        if u.get('speed') == 'fast' and top in FAST:
            fast += 1
        if u.get('inference_geo') == 'us' and top in RATES and RATES[top][5]:
            geo_us += 1
        if any(p['est'] for p in r['parts']):
            ttl_est += 1
        stu = u.get('server_tool_use') if isinstance(u.get('server_tool_use'), dict) else {}
        ws_req += stu.get('web_search_requests') or 0

    # Tools (A30)
    status = {'ok': 0, 'denied': 0, 'shell_exit': 0, 'failed': 0, 'unpaired': 0}
    by_id, calls_by_name = {}, {}
    ok_edit_lines = ok_write_lines = 0
    def lines_of(s):
        return 0 if not isinstance(s, str) or s == '' else s.count('\n') + 1
    for tid, use in uses.items():
        res = results.get(tid)
        if res is None:
            st = 'unpaired'
        elif res['denied']:
            st = 'denied'
        elif res['err'] and use['name'] in SHELL:
            st = 'shell_exit'
        elif res['err']:
            st = 'failed'
        else:
            st = 'ok'
        status[st] += 1
        by_id[tid] = st
        calls_by_name[use['name']] = calls_by_name.get(use['name'], 0) + 1
        if st == 'ok':
            if use['name'] == 'Edit':
                ok_edit_lines += lines_of(use['inp_new'])
            elif use['name'] == 'MultiEdit' and isinstance(use['inp_edits'], list):
                ok_edit_lines += sum(lines_of(x.get('new_string')) for x in use['inp_edits'] if isinstance(x, dict))
            elif use['name'] == 'Write':
                ok_write_lines += lines_of(use['inp_content'])
    orphan_results = sum(1 for tid in results if tid not in uses)

    # Time (A22 to A24)
    kept_activity = list(activity.values()) + no_uuid_activity
    by_session, by_file = {}, {}
    for a in kept_activity:
        by_session.setdefault(a['sid'], []).append(a['ts'])
        by_file.setdefault(a['fi'], []).append(a['ts'])
    def active_and_blocks(tl):
        tl = sorted(tl)
        act, blocks, start = 0, [], tl[0]
        for x, y in zip(tl, tl[1:]):
            if y - x <= idle_ms:
                act += y - x
            else:
                blocks.append(x - start)
                start = y
        blocks.append(tl[-1] - start)
        return act, blocks
    active_ms, block_ms = 0, []
    for sid, tl in by_session.items():
        a, b = active_and_blocks(tl)
        active_ms += a
        block_ms += b
    agent_ms, agent_by_class = 0, {'main': 0, 'subagent': 0, 'workflow_agent': 0}
    for fi, tl in by_file.items():
        a, _ = active_and_blocks(tl)
        agent_ms += a
        agent_by_class[files[fi]['cls']] = agent_by_class.get(files[fi]['cls'], 0) + a

    days, hours = {}, [0] * 24
    for ts in prompts.values():
        d, h, _ = local_parts(ts, tz)
        days[d] = days.get(d, 0) + 1
        hours[h] += 1
    active_days = sorted(days)
    streak = best = 0
    prev = None
    for d in active_days:
        cur = datetime.strptime(d, '%Y-%m-%d').date()
        streak = streak + 1 if prev is not None and (cur - prev).days == 1 else 1
        best = max(best, streak)
        prev = cur
    peak = None
    if prompts:
        peak = max(range(24), key=lambda h: (hours[h], -h))

    synth429.sort()
    episodes = 0
    last = None
    for ts in synth429:
        if last is None or ts - last > 30 * 60 * 1000:
            episodes += 1
        last = ts

    def sec(ms):
        return ms // 1000 if ms % 1000 == 0 else ms / 1000

    return {
        'scan': scan_stats,
        'dedup': {'observations': len(obs), 'keys': len(final_groups), 'gatewayConflicts': conflicts, 'invariantViolations': violations,
                  'forkedKeys': forked, 'syntheticLines': synthetic, 'duplicateToolUseIds': dup_tool_ids, 'orphanToolResults': orphan_results},
        'responses': len(responses),
        'incompleteResponses': sum(1 for r in responses if not r['complete']),
        'sessions': len({a['sid'] for a in kept_activity if a['sid']}),
        'tokens': tokens,
        'valueNano': str(total),
        'responseValueNano': dict(sorted(per_response.items())),
        'bucketsNano': {k: str(v) for k, v in buckets_total.items() if k != 'webSearch'},
        'webSearchNano': str(buckets_total['webSearch']),
        'byClassNano': {k: str(v) for k, v in by_class.items()},
        'byModelNano': {k: str(v) for k, v in sorted(by_model.items())},
        'sidechainNano': str(side_value),
        'pricedTokens': priced_tokens,
        'allTokens': all_tokens,
        'unpriced': sorted(unpriced.values(), key=lambda x: x['model']),
        'modifiers': {'fast': fast, 'geoUs': geo_us, 'ttlEstimated': ttl_est, 'webSearchRequests': ws_req},
        'tools': {'calls': len(uses), 'paired': sum(1 for tid in uses if tid in results), 'status': status,
                  'byId': dict(sorted(by_id.items())), 'callsByName': dict(sorted(calls_by_name.items())),
                  'okEditNewLines': ok_edit_lines, 'okWriteLines': ok_write_lines},
        'time': {'activeSeconds': sec(active_ms), 'workBlockSeconds': sorted(sec(b) for b in block_ms),
                 'agentSeconds': sec(agent_ms), 'agentSecondsByClass': {k: sec(v) for k, v in agent_by_class.items()}},
        'prompts': len(prompts),
        'interrupts': len(interrupts),
        'activeDays': active_days,
        'longestStreakDays': best,
        'peakHourLocal': peak,
        'rateLimits': {'quotaRejectWindows': len(windows), 'synthetic429Lines': len(synth429), 'episodes': episodes},
        'workflows': workflows,
        'methods': methods(files, obs, final_groups, responses, file_order),
    }


def methods(files, obs, final_groups, responses, file_order):
    """Value under each counting method (DESIGN 4.3 table, 9.4)."""
    correct = sum(r['value'] for r in responses)
    every = sum(response_value(o['model'], o['u'])[1] for o in obs)
    first = 0
    for g in final_groups.values():
        o = min(g, key=lambda x: (x['ts'] if x['ts'] is not None else 0,) + file_order(x['fi'], -x['ln']))
        first += response_value(o['model'], o['u'])[1]
    per_file = {}
    for o in obs:
        k = (o['fi'], o['key'])
        cur = per_file.get(k)
        if cur is None or (-o['out'], -o['ln']) < (-cur['out'], -cur['ln']):
            per_file[k] = o
    per_file_value = sum(response_value(o['model'], o['u'])[1] for o in per_file.values())
    all5 = sum(response_value(r['kept']['model'], r['kept']['u'], all_5m=True)[1] for r in responses)
    main_groups = {}
    for o in obs:
        if files[o['fi']]['cls'] == 'main':
            main_groups.setdefault(o['key'], []).append(o)
    main_only = sum(response_value(min(g, key=lambda x: (-x['out'],) + file_order(x['fi'], x['ln']))['model'],
                                   min(g, key=lambda x: (-x['out'],) + file_order(x['fi'], x['ln']))['u'])[1] for g in main_groups.values())
    return {'correct': str(correct), 'sumEveryLine': str(every), 'keepFirstLine': str(first), 'dedupPerFile': str(per_file_value),
            'allWritesAt5m': str(all5), 'mainFilesOnly': str(main_only)}


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('root')
    ap.add_argument('--tz', default='UTC')
    ap.add_argument('--idle-minutes', type=int, default=15)
    a = ap.parse_args(argv)
    json.dump(scan(a.root, a.tz, a.idle_minutes), sys.stdout, indent=1, sort_keys=False)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main(sys.argv[1:])
