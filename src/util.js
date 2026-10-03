'use strict';

// Shared validation and normalisation helpers.

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

function clean(value, max = 500) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text.slice(0, max);
}

// Like clean() but keeps line breaks (for descriptions).
function cleanMultiline(value, max = 4000) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return text === '' ? null : text.slice(0, max);
}

function normalizeKey(value) {
  return (value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameKey(first, last) {
  return normalizeKey(`${first || ''} ${last || ''}`);
}

// "Mary Ann Smith" -> { first_name: "Mary Ann", last_name: "Smith" }
function splitFullName(fullName) {
  const text = clean(fullName);
  if (!text) return null;
  const parts = text.split(' ');
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1] };
}

function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function cleanDate(value, label = 'date') {
  const text = clean(value);
  if (!text) return null;
  if (!isRealDate(text)) throw new ValidationError(`"${text}" is not a valid ${label} (expected YYYY-MM-DD).`);
  return text;
}

function cleanYear(value, label = 'year') {
  const text = clean(value);
  if (!text) return null;
  const year = Number(text);
  if (!/^\d{4}$/.test(text) || year < 1000 || year > new Date().getFullYear() + 5) {
    throw new ValidationError(`"${text}" is not a valid ${label}.`);
  }
  return year;
}

function cleanTime(value) {
  const text = clean(value);
  if (!text) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new ValidationError(`"${text}" is not a valid time (expected HH:MM).`);
  return text;
}

function cleanEmail(value) {
  const text = clean(value);
  if (!text) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new ValidationError(`"${text}" is not a valid email address.`);
  }
  return text.toLowerCase();
}

function truthy(value) {
  return value === true || value === 1 || value === '1' || value === 'on' || value === 'true' || value === 'yes';
}

function fullName(person) {
  return `${person.first_name || ''} ${person.last_name || ''}`.trim();
}

module.exports = {
  ValidationError,
  NotFoundError,
  AuthError,
  clean,
  cleanMultiline,
  normalizeKey,
  nameKey,
  splitFullName,
  isRealDate,
  cleanDate,
  cleanYear,
  cleanTime,
  cleanEmail,
  truthy,
  fullName,
};
