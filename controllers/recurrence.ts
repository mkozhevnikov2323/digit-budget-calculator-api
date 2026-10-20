import type { RequestHandler } from 'express';
import mongoose = require('mongoose');
import Expense = require('../models/expense');
import Income = require('../models/income');
import { analyzeRecurrence, type Operation } from '../domain/recurrence';

// Provisional limits for the new read-only contract, not an approved history policy.
const MAX_MONTHS = 12;
const MAX_PER_DATASET = 1000;
const QUERY_TIMEOUT_MS = 3000;

const index = (value: string): number => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value.startsWith('0000')) {
    throw new TypeError('Invalid UTC month');
  }
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
};
const monthText = (i: number): string =>
  String(Math.floor(i / 12)).padStart(4, '0') + '-' + String(i % 12 + 1).padStart(2, '0');

type StoredRow = {
  _id: mongoose.Types.ObjectId;
  owner: mongoose.Types.ObjectId;
  date: Date;
  category?: string | null;
  title?: string;
  recipient?: string;
  source?: string;
};

const convert = (value: unknown, dataset: 'expenses' | 'incomes', ownerId: string): Operation => {
  // Narrow DB boundary: failed validation is an error, never a partial report.
  if (!value || typeof value !== 'object') throw new TypeError('Invalid stored operation');
  const row = value as Partial<StoredRow>;
  if (!(row._id instanceof mongoose.Types.ObjectId)
    || !(row.owner instanceof mongoose.Types.ObjectId)
    || row.owner.toHexString() !== ownerId
    || !(row.date instanceof Date) || !Number.isFinite(row.date.getTime())) {
    throw new TypeError('Invalid stored operation identity/date');
  }
  const base = { id: row._id.toHexString(), ownerId, occurredAt: row.date.toISOString() };
  if (dataset === 'expenses') {
    if (row.category != null && typeof row.category !== 'string') throw new TypeError('Invalid stored category');
    if (row.title != null && typeof row.title !== 'string') throw new TypeError('Invalid stored title');
    if (row.recipient != null && typeof row.recipient !== 'string') throw new TypeError('Invalid stored recipient');
    return { ...base, dataset, category: row.category == null ? null :
      { provenance: 'label_only', value: row.category },
    title: row.title ?? '', recipient: row.recipient ?? '' };
  }
  if (row.source != null && typeof row.source !== 'string') throw new TypeError('Invalid stored source');
  return { ...base, dataset, source: row.source ?? '' };
};

const getRecurrence: RequestHandler = async (req, res, next) => {
  try {
    const ownerClaim = req.user;
    if (!ownerClaim || typeof ownerClaim !== 'object' || !('_id' in ownerClaim)
      || typeof ownerClaim._id !== 'string' || !/^[a-fA-F0-9]{24}$/.test(ownerClaim._id)) {
      res.status(401).json({ message: 'Необходима авторизация.' });
      return;
    }
    const ownerId = ownerClaim._id.toLowerCase();
    const startMonth = req.query.startMonth as string;
    const endMonthExclusive = req.query.endMonthExclusive as string;
    const start = index(startMonth), end = index(endMonthExclusive);
    const now = new Date();
    const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
    if (end <= start || end - start > MAX_MONTHS || end > current) {
      res.status(400).json({ message: 'Invalid completed UTC month range' });
      return;
    }
    const startDate = new Date(startMonth + '-01T00:00:00.000Z');
    const endDate = new Date(endMonthExclusive + '-01T00:00:00.000Z');
    const filter = { owner: ownerId, date: { $gte: startDate, $lt: endDate } };
    // Bounded reads of exactly the necessary fields. No pagination or client-supplied owner/filter.
    const [expenses, incomes]: [unknown[], unknown[]] = await Promise.all([
      Expense.find(filter).select('_id owner date category title recipient').sort({ _id: 1 })
        .limit(MAX_PER_DATASET + 1).maxTimeMS(QUERY_TIMEOUT_MS).lean(),
      Income.find(filter).select('_id owner date source').sort({ _id: 1 })
        .limit(MAX_PER_DATASET + 1).maxTimeMS(QUERY_TIMEOUT_MS).lean(),
    ]);
    if (expenses.length > MAX_PER_DATASET || incomes.length > MAX_PER_DATASET) {
      res.status(413).json({ message: 'Recurrence history exceeds safe read limit' });
      return;
    }
    const completeMonths: string[] = [];
    for (let i = start; i < end; i++) completeMonths.push(monthText(i));
    const analyzed = analyzeRecurrence({
      ownerId, startMonth, endMonthExclusive, completeMonths,
      operations: [...expenses.map(row => convert(row, 'expenses', ownerId)),
        ...incomes.map(row => convert(row, 'incomes', ownerId))],
    });
    // "Complete" means the bounded MongoDB range queries terminated; it does NOT
    // prove continuous bookkeeping history or an atomic snapshot across collections.
    res.status(200).json({
      version: analyzed.version,
      window: { startMonth, endMonthExclusive },
      coverage: {
        source: 'stored_records_only',
        historicalContinuity: 'unverified',
        atomicSnapshot: false,
        maxRecordsPerDataset: MAX_PER_DATASET,
      },
      observations: analyzed.observations,
    });
  } catch (error) {
    next(error);
  }
};

export = getRecurrence;
