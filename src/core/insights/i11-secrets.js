// I11. Secrets in transcripts (DESIGN 6 I11, traps 52 to 56).
//
// Reads the grouped findings accounting keeps (AccountingResult.secrets, shaped by
// secrets.groupSecretEvents) and turns them into report rows: type, fingerprint, copies, files,
// newest local date, severity, source and project labels. There is no value field anywhere in
// the chain, so there is nothing to leak: the scanner never returns one. This insight also
// refuses any row whose fingerprint or type does not match its strict pattern, so a malformed
// upstream record cannot smuggle text into the Summary. Never on the card (public.js reads
// nothing from i11).
//
// Isomorphic: no node:* imports and no DOM.

import { defineInsight } from './contract.js';
import { SECRET_SEVERITIES, SECRET_SOURCES } from '../adapters/contract.js';
import { SECRET_TYPE_IDS, compareGrouped } from '../secrets.js';
import { localDate, projectLabeler } from './_util.js';

export const ACTION_SECRETS = 'Rotate each critical key at its provider first, then delete every copy (auditrail secrets --locations lists the session files, in the terminal only), then add permission deny rules for secret files, for example "deny": ["Read(./.env)"]. For a deeper scan, see agent-leaks.';

const FP_RE = /^[0-9a-f]{12}$/;

export const insight = defineInsight({
  id: 'i11',
  title: 'Secrets in transcripts',
  compute({ acc, options }) {
    const label = projectLabeler(acc, Boolean(options.redact));
    const rows = [];
    for (const s of Array.isArray(acc.secrets) ? acc.secrets : []) {
      if (!s || !FP_RE.test(String(s.fingerprint12)) || !SECRET_TYPE_IDS.includes(s.secretType)) continue;
      if (!SECRET_SEVERITIES.includes(s.severity) || !SECRET_SOURCES.includes(s.source)) continue;
      rows.push({
        secretType: s.secretType,
        fingerprint12: s.fingerprint12,
        copies: Number.isSafeInteger(s.copies) ? s.copies : 0,
        files: Number.isSafeInteger(s.files) ? s.files : 0,
        newestLocalDate: localDate(s.newestTs, options.tz),
        severity: s.severity,
        source: s.source,
        expired: s.expired === true ? true : null,
        projectLabels: [...new Set((Array.isArray(s.projectKeys) ? s.projectKeys : []).map((k) => label(k)))].sort(),
        newestTs: typeof s.newestTs === 'number' ? s.newestTs : null,
      });
    }
    rows.sort(compareGrouped);
    const findings = rows.map(({ newestTs, ...r }) => r);
    const bySeverity = { critical: 0, likely_fixture: 0, third_party_public: 0 };
    let criticalCopies = 0;
    for (const f of findings) {
      bySeverity[/** @type {keyof typeof bySeverity} */ (f.severity)]++;
      if (f.severity === 'critical') criticalCopies += f.copies;
    }
    const data = { findings, bySeverity };
    return {
      id: 'i11',
      shown: findings.length > 0,
      data,
      evidence: { count: bySeverity.critical, unit: 'critical findings' },
      action: bySeverity.critical > 0 ? ACTION_SECRETS + ' Critical copies on disk: ' + criticalCopies + '.' : ACTION_SECRETS,
    };
  },
});
