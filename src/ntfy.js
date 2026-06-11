import { logError } from './logger.js';

export async function notify({ title, body, tags = [], priority = 'default' }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    logError('NTFY_TOPIC lipsește din env');
    return;
  }
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: {
        'Title': title,
        'Priority': priority,
        ...(tags.length > 0 ? { 'Tags': tags.join(',') } : {}),
      },
      body,
    });
    if (!res.ok) {
      logError('ntfy push failed', { status: res.status });
    }
  } catch (err) {
    logError('ntfy fetch failed', { error: err.message });
  }
}
