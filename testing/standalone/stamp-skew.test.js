/**
 * A record's own timestamp, checked against the server's — including the compact form the board actually writes.
 *
 * ## What this is for
 *
 * The canary operator corrected three board posts whose `postedAt` was **eight hours** early. Not clock drift: they
 * measured the clock once and extrapolated the next three stamps from how long they thought their work had taken. Their
 * sentence for why nothing caught it is the requirement — *"an estimated timestamp looks exactly like a measured one
 * once it is written down"* — and their suggestion is why it is ours: the comparison is available to the store and not
 * to the author.
 *
 * ## The parse is the substance, so it is tested against THEIR strings
 *
 * Their stamps are written `2026-08-11T1200Z`. `new Date('2026-08-11T1200Z')` is **Invalid Date**. A check built on
 * `Date.parse` alone therefore finds nothing to compare on precisely the records that motivated the ask — and reports no
 * skew for a stamp eight hours wrong. That is not a weak feature, it is one that confidently says the opposite of the
 * truth on its own motivating example.
 *
 * So the strings below are copied from the board, not invented here: `2026-08-11T1200Z`, `2026-08-12T1129Z`,
 * `2026-08-09T0942Z`. If the compact branch is ever dropped, these fail rather than quietly passing on `null`.
 *
 * Run: node --test testing/standalone/stamp-skew.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseStamp, detectStampSkew, stampSkewSettings, stampSkewWarning,
} = await import('../../server/dist/brain/stamp-skew.js');

const HOUR = 3_600_000;

describe('parseStamp — the compact board form is the case that matters', () => {
  it('parses the exact stamps from the board', () => {
    // Copied from real messages. `Date.parse` alone returns NaN for every one of these.
    for (const [raw, expected] of [
      ['2026-08-11T1200Z', '2026-08-11T12:00:00.000Z'],
      ['2026-08-12T1129Z', '2026-08-12T11:29:00.000Z'],
      ['2026-08-09T0942Z', '2026-08-09T09:42:00.000Z'],
      ['2026-08-13T0035Z', '2026-08-13T00:35:00.000Z'],
    ]) {
      const ms = parseStamp(raw);
      assert.ok(ms !== null, `${raw} must parse — this is the form the board writes`);
      assert.equal(new Date(ms).toISOString(), expected, raw);
    }
  });

  it('proves the platform cannot do it, so the branch is not redundant', () => {
    // If this ever starts passing, the compact branch can go. Until then, deleting it silently disables the check.
    assert.ok(Number.isNaN(Date.parse('2026-08-11T1200Z')),
      'Date.parse learned the compact form — re-examine whether parseStamp still needs its own branch');
  });

  it('parses ordinary ISO 8601 too', () => {
    assert.equal(new Date(parseStamp('2026-08-11T12:00:00Z')).toISOString(), '2026-08-11T12:00:00.000Z');
    assert.equal(new Date(parseStamp('2026-08-11T12:00:00.500Z')).toISOString(), '2026-08-11T12:00:00.500Z');
  });

  it('honours an offset in the compact form rather than assuming UTC', () => {
    // 14:00+02:00 is 12:00Z. Assuming UTC here would invent a two-hour skew on a correct stamp, which is worse than
    // not checking: a false warning about a right number teaches a reader to ignore the warnings.
    assert.equal(new Date(parseStamp('2026-08-11T1400+02:00')).toISOString(), '2026-08-11T12:00:00.000Z');
    assert.equal(new Date(parseStamp('2026-08-11T1400+0200')).toISOString(), '2026-08-11T12:00:00.000Z');
  });

  it('takes seconds in the compact form', () => {
    assert.equal(new Date(parseStamp('2026-08-11T120059Z')).toISOString(), '2026-08-11T12:00:59.000Z');
  });

  it('distinguishes epoch seconds from milliseconds', () => {
    assert.equal(new Date(parseStamp(1786594894)).toISOString(), new Date(1786594894000).toISOString());
    assert.equal(new Date(parseStamp(1786594894663)).toISOString(), new Date(1786594894663).toISOString());
  });

  it('returns null for things that are not timestamps, rather than a number', () => {
    // `null` means NOT CHECKED. Inventing a skew for `"soon"` would warn about the wrong thing entirely.
    for (const bad of ['soon', '', '   ', 'yesterday', {}, [], null, undefined, NaN, '2026-13-45T9999Z']) {
      assert.equal(parseStamp(bad), null, `${JSON.stringify(bad)} must not parse`);
    }
  });
});

describe('detectStampSkew — eight hours is caught, forty minutes is not', () => {
  const createdAt = '2026-08-09T17:42:00.000Z';

  it('catches the eight-hour case that started this', () => {
    // Their actual failure: the stamp says 0942Z, the server wrote it at 1742Z.
    const skew = detectStampSkew({ postedAt: '2026-08-09T0942Z' }, createdAt, undefined);
    assert.ok(skew, 'an eight-hour disagreement must be reported');
    assert.equal(skew.property, 'postedAt');
    assert.equal(skew.stamp, '2026-08-09T0942Z', 'the stamp is quoted back as written — the point is that it looks right');
    assert.equal(skew.skewMs, -8 * HOUR, 'negative: the caller stamped it EARLIER than the write');
  });

  it('stays quiet inside the protocol tolerance', () => {
    // The board's own documented assumption is that two clocks differ by up to forty minutes, so warning there is noise.
    assert.equal(detectStampSkew({ stampedAt: '2026-08-09T1712Z' }, createdAt, undefined), null,
      '30 minutes is inside the tolerance the protocol already accepts');
    assert.equal(detectStampSkew({ stampedAt: createdAt }, createdAt, undefined), null);
  });

  it('fires just past the threshold, not just inside it', () => {
    // The boundary in both directions, because an off-by-one here means either a silent check or a noisy one.
    const at40 = new Date(Date.parse(createdAt) + 40 * 60_000).toISOString();
    const at41 = new Date(Date.parse(createdAt) + 41 * 60_000).toISOString();
    assert.equal(detectStampSkew({ stampedAt: at40 }, createdAt, undefined), null, 'exactly at the threshold is inside it');
    assert.ok(detectStampSkew({ stampedAt: at41 }, createdAt, undefined), 'one minute past it reports');
  });

  it('reports a stamp in the FUTURE as well', () => {
    // A clock that is ahead is the same defect with the sign flipped, and "we posted this tomorrow" is at least as
    // confusing to a reader as an eight-hour backdate.
    const skew = detectStampSkew({ postedAt: '2026-08-10T0942Z' }, createdAt, undefined);
    assert.ok(skew);
    assert.ok(skew.skewMs > 0, 'positive means the stamp is after the write');
  });

  it('checks the properties in order and lets the FIRST parseable one speak', () => {
    // Reporting the worst of several would let a caller's sloppier second field speak for a record whose real stamp was
    // fine — the record would be flagged for a field nobody treats as authoritative.
    const skew = detectStampSkew(
      { stampedAt: createdAt, postedAt: '2026-08-09T0942Z' }, createdAt, undefined,
    );
    assert.equal(skew, null, 'stampedAt is checked first, agrees, and settles it');
  });

  it('skips an unparseable stamp and moves on to the next property', () => {
    const skew = detectStampSkew({ stampedAt: 'soon', postedAt: '2026-08-09T0942Z' }, createdAt, undefined);
    assert.ok(skew, 'an unparseable first property must not silence the check');
    assert.equal(skew.property, 'postedAt');
  });

  it('reports nothing when there is no stamp property at all', () => {
    assert.equal(detectStampSkew({ author: 'someone' }, createdAt, undefined), null);
    assert.equal(detectStampSkew(undefined, createdAt, undefined), null);
    assert.equal(detectStampSkew({}, createdAt, undefined), null);
  });

  it('is DISABLED by warnMinutes: 0, not made maximally strict', () => {
    // The reading that matters: zero as "warn on any difference" would fire on every record in the space, because a
    // caller's stamp and the server's clock never agree to the millisecond. Someone setting 0 wants the check off.
    const meta = { stampSkew: { warnMinutes: 0 } };
    assert.equal(detectStampSkew({ postedAt: '2026-08-09T0942Z' }, createdAt, meta), null);
    assert.equal(stampSkewSettings(meta).warnMs, 0);
  });

  it('takes its threshold and its property names from space meta', () => {
    // The Verify line for this item: the threshold is READ FROM CONFIG, not a constant.
    const tight = { stampSkew: { warnMinutes: 5 } };
    assert.ok(detectStampSkew({ stampedAt: '2026-08-09T1712Z' }, createdAt, tight),
      '30 minutes must report once the space asks for 5');

    const named = { stampSkew: { properties: ['recordedAt'] } };
    assert.ok(detectStampSkew({ recordedAt: '2026-08-09T0942Z' }, createdAt, named),
      'a space can name its own property');
    assert.equal(detectStampSkew({ postedAt: '2026-08-09T0942Z' }, createdAt, named), null,
      'and naming one REPLACES the defaults rather than adding to them');
  });
});

describe('the warning a caller actually reads', () => {
  it('says hours, the direction, and that the record was STORED', () => {
    const text = stampSkewWarning({
      property: 'postedAt', stamp: '2026-08-09T0942Z', skewMs: -8 * HOUR, thresholdMs: 40 * 60_000,
    });
    assert.match(text, /postedAt/);
    assert.match(text, /8\.0 hours/, 'hours, because that is the unit the failure was described in');
    assert.match(text, /BEFORE/);
    assert.match(text, /stored as sent|not a rejection/i,
      'a caller must not read this as a failed write — the whole design is warn-not-refuse');
  });

  it('uses minutes when hours would read as 0.4', () => {
    const text = stampSkewWarning({
      property: 'stampedAt', stamp: 'x', skewMs: 45 * 60_000, thresholdMs: 40 * 60_000,
    });
    assert.match(text, /45 minutes/);
    assert.match(text, /AFTER/);
  });
});
