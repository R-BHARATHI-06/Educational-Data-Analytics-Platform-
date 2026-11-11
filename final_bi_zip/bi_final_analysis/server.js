const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const {URL} = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const DEFAULT_MAIL_ID = 'kulandhaivelkeerthi@gmail.com';
const SMTP = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.EMAIL_USER || process.env.SMTP_USER || DEFAULT_MAIL_ID,
  pass: process.env.EMAIL_PASS || process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.EMAIL_USER || process.env.SMTP_USER || DEFAULT_MAIL_ID,
  secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true'
};

const files = {
  companies: path.join(DATA_DIR, 'company_rules.csv'),
  students: path.join(DATA_DIR, 'students.csv'),
  users: path.join(DATA_DIR, 'users.csv'),
  deadlines: path.join(DATA_DIR, 'deadlines.csv')
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted && ch === '"' && next === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some(value => value !== '')) rows.push(row);
  }

  const [headers = [], ...records] = rows;
  return records.map(record => Object.fromEntries(headers.map((header, index) => [header, record[index] || ''])));
}

function toCsv(rows, headers) {
  const escape = value => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `${headers.join(',')}\n${rows.map(row => headers.map(header => escape(row[header])).join(',')).join('\n')}\n`;
}

function readCsv(file) {
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

function writeCsv(file, rows, headers) {
  fs.writeFileSync(file, toCsv(rows, headers), 'utf8');
}

function listField(value) {
  return String(value || '').split('|').map(item => item.trim()).filter(Boolean);
}

function normalizeCompany(row) {
  return {
    name: row.name,
    role: row.role,
    minCgpa: Number(row.minCgpa || 0),
    package: row.package,
    skills: listField(row.skills),
    match: row.match || 'all',
    minInternships: Number(row.minInternships || 0),
    certs: listField(row.certs),
    department: row.department || 'Any',
    additional: row.additional || '-'
  };
}

function normalizeStudent(row) {
  return {
    name: row.name,
    regNo: row.regNo,
    cgpa: Number(row.cgpa || 0),
    department: row.department,
    skills: listField(row.skills),
    internships: Number(row.internships || 0),
    certifications: listField(row.certifications)
  };
}

function normalizeUser(row) {
  return {
    name: row.name,
    role: row.role,
    id: row.id,
    department: row.department,
    email: row.email,
    status: row.status || 'Active'
  };
}

function normalizeAudience(value) {
  const audience = String(value || '').toLowerCase();
  if (audience === 'students') return 'Student';
  if (audience === 'faculty') return 'Faculty';
  if (audience === 'alumni') return 'Alumni';
  return value;
}

function addDays(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function getYearTargetEmail(yearTarget) {
  const mapping = {
    '1st Year': '927623bit016@mkce.ac.in',
    '2nd Year': '927623bit021@mkce.ac.in',
    '3rd Year': 'keerthikulandhaivel308@gmail.com',
    '4th Year': 'gowshikadevaraju@gmail.com',
    'Final Year': 'gowshikadevaraju@gmail.com'
  };
  return mapping[yearTarget] || null;
}

function isYearTarget(target) {
  return target && ['1st Year', '2nd Year', '3rd Year', '4th Year', 'Final Year'].includes(target);
}

function isSmtpConfigured() {
  return Boolean(SMTP.host && SMTP.user && SMTP.pass && SMTP.from);
}

function readSmtpResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        socket.off('data', onData);
        socket.off('error', onError);
        resolve(buffer);
      }
    };
    const onError = error => {
      socket.off('data', onData);
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function smtpCommand(socket, command, expected=/^[23]/) {
  if (command) socket.write(`${command}\r\n`);
  const response = await readSmtpResponse(socket);
  if (!expected.test(response)) throw new Error(response.trim());
  return response;
}

function connectSmtp() {
  return new Promise((resolve, reject) => {
    const socket = SMTP.secure
      ? tls.connect(SMTP.port, SMTP.host, {servername: SMTP.host})
      : net.connect(SMTP.port, SMTP.host);
    socket.once('connect', () => resolve(socket));
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
    socket.setTimeout(15000, () => {
      socket.destroy();
      reject(new Error('SMTP connection timed out'));
    });
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function formatDisplayDate(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(dateValue || 'Not set');
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

function getDaysRemaining(dateValue) {
  const today = new Date();
  const deadline = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(deadline.getTime())) return 0;
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.ceil((deadline - today) / 86400000));
}

function formatDeadlineEmailHtml(alert) {
  const daysLeft = Number(alert.daysLeft || 0);
  const dayLabel = daysLeft === 1 ? '1 Day Remaining' : `${daysLeft} Days Remaining`;
  const urgencyLine = daysLeft === 1 ? 'Time remaining: 1 day' : `Time remaining: ${daysLeft} days`;
  return `<!doctype html>
<html>
  <body style="margin:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#7f1d1d;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;padding:28px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;width:100%;">
            <tr>
              <td style="text-align:center;font-size:15px;font-weight:700;color:#b91c1c;padding-bottom:18px;">🚨 Deadline Alert - ${escapeHtml(dayLabel)}</td>
            </tr>
            <tr>
              <td style="background:#fff1f2;border-left:5px solid #dc2626;border-radius:8px;padding:18px 20px;">
                <div style="font-size:13px;font-weight:700;color:#991b1b;margin-bottom:12px;">📋 ${escapeHtml(alert.title || alert.subject)}</div>
                <div style="font-size:12px;color:#7f1d1d;margin-bottom:16px;">${escapeHtml(alert.course || 'Assessment')}</div>
                <div style="height:1px;background:#fecdd3;margin-bottom:16px;"></div>
                <div style="font-size:13px;font-weight:700;color:#991b1b;margin-bottom:10px;">📅 Deadline: ${escapeHtml(formatDisplayDate(alert.deadlineDate))}</div>
                <div style="font-size:12px;color:#991b1b;margin-bottom:16px;">⏳ ${escapeHtml(urgencyLine)}</div>
                <div style="background:#b91c1c;color:#ffffff;text-align:center;border-radius:3px;font-size:12px;font-weight:700;padding:11px 12px;">Please complete this task immediately to avoid missing the deadline.</div>
              </td>
            </tr>
            <tr>
              <td style="text-align:center;font-size:11px;color:#94a3b8;padding-top:18px;">This is an automated notification from the BI Portal. Do not reply to this email.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function formatEmailMessage(alert) {
  const from = SMTP.from;
  const to = alert.toEmail;
  const subject = String(alert.subject || '').replace(/\r?\n/g, ' ');
  const html = formatDeadlineEmailHtml(alert);
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8'
  ];
  return `${headers.join('\r\n')}\r\n\r\n${html.replace(/^\./gm, '..')}\r\n.`;
}

async function sendEmailNow(alert) {
  if (!isSmtpConfigured()) throw new Error('SMTP is not configured');
  let socket = await connectSmtp();
  await smtpCommand(socket, null);
  await smtpCommand(socket, 'EHLO localhost');
  if (!SMTP.secure) {
    await smtpCommand(socket, 'STARTTLS');
    socket = tls.connect({socket, servername: SMTP.host});
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    await smtpCommand(socket, 'EHLO localhost');
  }
  await smtpCommand(socket, 'AUTH LOGIN', /^334/);
  await smtpCommand(socket, Buffer.from(SMTP.user).toString('base64'), /^334/);
  await smtpCommand(socket, Buffer.from(SMTP.pass).toString('base64'), /^235/);
  await smtpCommand(socket, `MAIL FROM:<${SMTP.from}>`);
  await smtpCommand(socket, `RCPT TO:<${alert.toEmail}>`);
  await smtpCommand(socket, 'DATA', /^354/);
  await smtpCommand(socket, formatEmailMessage(alert));
  await smtpCommand(socket, 'QUIT', /^[23]/).catch(() => {});
  socket.end();
  return {status:'Sent', detail:'Email sent through SMTP'};
}

async function sendAndMarkAlert(alert) {
  try {
    const result = await sendEmailNow(alert);
    return {...alert, status:result.status, smtpMessage:result.detail};
  } catch (error) {
    if (error.message === 'SMTP is not configured') {
      return {...alert, status:'Queued', smtpMessage:'SMTP password is not configured'};
    }
    return {...alert, status:'Send Failed', smtpMessage:error.message};
  }
}

async function sendDeadlineEmails(deadline) {
  const users = readCsv(files.users).map(normalizeUser);
  const targetRole = normalizeAudience(deadline.audience);
  const yearTargetEmail = getYearTargetEmail(deadline.target);
  const recipients = isYearTarget(deadline.target) && yearTargetEmail
    ? [{name: deadline.target, email: yearTargetEmail}]
    : users.filter(user => user.role === targetRole && user.email && user.status !== 'Inactive');
  const createdAt = new Date().toISOString();
  const daysLeft = getDaysRemaining(deadline.date);
  const dayText = daysLeft === 1 ? '1 Day Left' : `${daysLeft} Days Left`;
  const subject = `URGENT: Only ${dayText} - ${deadline.title}`;
  const message = `${deadline.title} for ${deadline.subject || 'General'} is due on ${deadline.date}. Target: ${deadline.target || deadline.audience}.`;

  const emails = recipients.map(user => ({
    createdAt,
    toEmail: user.email,
    toName: user.name,
    audience: deadline.audience,
    subject,
    message,
    title: deadline.title,
    course: deadline.subject || 'Assessment',
    deadlineDate: deadline.date,
    daysLeft,
    status: 'Sending'
  }));

  const results = [];
  for (const email of emails) {
    results.push(await sendAndMarkAlert(email));
  }
  return {
    recipients: recipients.length,
    sent: results.filter(item => item.status === 'Sent').length,
    failed: results.filter(item => item.status === 'Send Failed').length,
    queued: results.filter(item => item.status === 'Queued').length,
    results
  };
}

function sameSkill(actual, required) {
  const a = String(actual).toLowerCase();
  const r = String(required).toLowerCase();
  if (r === 'programming') return ['java', 'python', 'sql', 'web', 'react', 'machine learning'].some(token => a.includes(token));
  if (r === 'dsa') return a.includes('dsa') || a.includes('data structures');
  if (r === 'cloud computing') return a.includes('cloud') || a.includes('aws') || a.includes('gcp');
  return a.includes(r) || r.includes(a);
}

function analyzeCompanyFit(company, student) {
  const matchedSkills = company.skills.filter(req => student.skills.some(skill => sameSkill(skill, req)));
  const skillOk = company.match === 'all' ? matchedSkills.length === company.skills.length : matchedSkills.length > 0 || company.skills.includes('Programming');
  return student.cgpa >= company.minCgpa && student.internships >= company.minInternships && skillOk;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(ROOT, requested);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
  res.writeHead(200, {'Content-Type': `${type}; charset=utf-8`});
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/company-rules') {
      sendJson(res, 200, readCsv(files.companies).map(normalizeCompany));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/students') {
      sendJson(res, 200, readCsv(files.students).map(normalizeStudent));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/mail-alerts') {
      sendJson(res, 200, []);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/mail-alerts') {
      const payload = await readBody(req);
      const email = {
        createdAt: new Date().toISOString(),
        toEmail: payload.toEmail,
        toName: payload.toName || '',
        audience: payload.audience || 'Manual',
        subject: payload.subject,
        message: payload.message,
        status: 'Sending'
      };
      if (!email.toEmail || !email.subject || !email.message) {
        sendJson(res, 400, {error: 'toEmail, subject, and message are required'});
        return;
      }
      const result = await sendAndMarkAlert(email);
      sendJson(res, result.status === 'Sent' ? 201 : 502, result);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/eligibility-screening') {
      const companyName = url.searchParams.get('company') || 'TCS';
      const company = readCsv(files.companies).map(normalizeCompany).find(item => item.name === companyName);
      if (!company) {
        sendJson(res, 404, {error: 'Company not found'});
        return;
      }
      const students = readCsv(files.students).map(normalizeStudent);
      sendJson(res, 200, students.filter(student => analyzeCompanyFit(company, student)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/company-rules') {
      const payload = await readBody(req);
      const rows = readCsv(files.companies);
      const row = {
        name: payload.name,
        role: payload.role || 'Custom Role',
        minCgpa: payload.minCgpa,
        package: payload.package || 'Configured',
        skills: (payload.skills || []).join('|'),
        match: payload.match || 'all',
        minInternships: payload.minInternships || 0,
        certs: (payload.certs || []).join('|'),
        department: payload.department || 'Any',
        additional: payload.additional || '-'
      };
      const index = rows.findIndex(item => item.name.toLowerCase() === row.name.toLowerCase());
      if (index >= 0) rows[index] = row;
      else rows.push(row);
      writeCsv(files.companies, rows, ['name', 'role', 'minCgpa', 'package', 'skills', 'match', 'minInternships', 'certs', 'department', 'additional']);
      sendJson(res, 200, normalizeCompany(row));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/users') {
      const payload = await readBody(req);
      const rows = readCsv(files.users);
      const row = {
        name: payload.name,
        role: payload.role,
        id: payload.id,
        department: payload.department,
        email: payload.email || `${String(payload.id || 'user').toLowerCase()}@college.edu`,
        status: payload.status || 'Active'
      };
      rows.unshift(row);
      writeCsv(files.users, rows, ['name', 'role', 'id', 'department', 'email', 'status']);
      sendJson(res, 201, row);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/deadlines') {
      const payload = await readBody(req);
      const row = {
        title: payload.title,
        date: payload.date,
        audience: payload.audience,
        target: payload.target || payload.audience,
        subject: payload.subject || 'General',
        createdBy: payload.createdBy || 'Admin',
        description: payload.description || ''
      };
      const rows = readCsv(files.deadlines);
      rows.unshift(row);
      writeCsv(files.deadlines, rows, ['title', 'date', 'audience', 'target', 'subject', 'createdBy', 'description']);
      const mail = await sendDeadlineEmails(row);
      sendJson(res, 201, {deadline: row, mail});
      return;
    }

    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, {error: error.message});
  }
});

server.listen(PORT, () => {
  console.log(`EduAnalytics backend running at http://localhost:${PORT}`);
});
