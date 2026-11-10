/** Group identities are independent of financial roles and never determine cashflow sign. */
import { FINANCIAL_LAYERS, type Dataset } from '../classification';
import { readWriteFields } from './writeCommand';
export const GROUP_TAXONOMY = 'financial-classification-groups-v3' as const;
export const GROUP_API = 'classification-groups-v3' as const;
export const normalizeGroupName = (s: string) => s.trim().toLowerCase();
const expenseNames = [
  'Повседневные расходы',
  'Нерегулярные расходы',
  'Непредвиденные расходы',
  'Крупные цели',
  'Долгосрочный капитал',
];
const incomes = {
  ordinary_income: 'Обычные поступления',
  loan_repayment: 'Возврат займа',
  refund: 'Возврат покупки',
  internal_transfer: 'Внутренний перевод',
  capital_movement: 'Возврат капитала',
};
export const SYSTEM_GROUPS = Object.freeze([
  ...FINANCIAL_LAYERS.map((code, i) => ({
    groupId: `system:expenses:${code}`,
    dataset: 'expenses' as const,
    name: expenseNames[i],
    compatibilityOnly: false,
  })),
  ...Object.entries(incomes).map(([code, name]) => ({
    groupId: `system:incomes:${code}`,
    dataset: 'incomes' as const,
    name,
    compatibilityOnly: false,
  })),
  ...Object.entries({
    loan_issuance: 'Выданные займы',
    internal_transfer: 'Внутренние переводы',
    capital_movement: 'Перечисления капитала',
  }).map(([code, name]) => ({
    groupId: `system:expenses:role:${code}`,
    dataset: 'expenses' as const,
    name,
    compatibilityOnly: true,
  })),
]);
export const systemGroup = (id: string) =>
  SYSTEM_GROUPS.find((g) => g.groupId === id);
export const groupId = (v: unknown): v is string =>
  typeof v === 'string' &&
  (!!systemGroup(v) ||
    (v.length === 43 &&
      /^custom:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        v,
      )));
export const validGroupName = (v: unknown): v is string =>
  typeof v === 'string' &&
  v === v.trim() &&
  v.length > 0 &&
  v.length <= 120 &&
  Buffer.byteLength(v, 'utf8') <= 480 &&
  !/[\u0000-\u001f\u007f]/.test(v) &&
  Buffer.from(v, 'utf8').toString('utf8') === v;
export const id = (v: unknown): v is string =>
  typeof v === 'string' && v.length === 24 && /^[a-f0-9]{24}$/.test(v);
export const dataset = (v: unknown): v is Dataset =>
  v === 'expenses' || v === 'incomes';
export const revision = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
export const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length === 36 &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    v,
  );
export const fields = readWriteFields;
export const legacyGroup = (
  ds: Dataset,
  assignment: { economicRole: string; layer: string | null },
) => {
  if (ds === 'expenses' && assignment.economicRole === 'ordinary_expense')
    return `system:expenses:${assignment.layer}`;
  return ds === 'expenses'
    ? `system:expenses:role:${assignment.economicRole}`
    : `system:incomes:${assignment.economicRole}`;
};
