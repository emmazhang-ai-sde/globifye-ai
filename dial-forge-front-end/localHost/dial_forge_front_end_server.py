#!/usr/bin/env python3
import http.server
import json
import socketserver
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PORT = 8000
BIND_ADDRESS = '0.0.0.0'
SIP_DEMO_PREFIX = '/sip-demo'
SIP_DEMO_BASE_URL = 'http://127.0.0.1:8400'
FRONTEND_PROXY_HEADER = 'X-DialForge-Frontend-Proxy'
DEMO_USERS_PATH = Path(__file__).with_name('product_demo_users.json')
DEMO_CONTACTS_PATH = Path(__file__).with_name('product_demo_contacts.json')
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SUPABASE_ENV_PATH = REPO_ROOT / 'dial-forge-ai' / 'ai-pipeline' / '.env.local'


def _read_env_file(path):
    values = {}
    try:
        lines = Path(path).read_text().splitlines()
    except OSError:
        return values

    for line in lines:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


_file_env = _read_env_file(os.environ.get('DIALFORGE_SUPABASE_ENV', DEFAULT_SUPABASE_ENV_PATH))
SUPABASE_URL = (
    os.environ.get('SUPABASE_SIP_URL')
    or os.environ.get('NEXT_PUBLIC_SUPABASE_URL')
    or _file_env.get('SUPABASE_SIP_URL')
    or _file_env.get('NEXT_PUBLIC_SUPABASE_URL')
    or ''
).rstrip('/')
SUPABASE_ANON_KEY = (
    os.environ.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')
    or _file_env.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')
    or ''
)
SUPABASE_SERVICE_ROLE_KEY = (
    os.environ.get('SUPABASE_SIP_SERVICE_ROLE_KEY')
    or os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    or _file_env.get('SUPABASE_SIP_SERVICE_ROLE_KEY')
    or _file_env.get('SUPABASE_SERVICE_ROLE_KEY')
    or ''
)
ALLOW_LOCAL_AUTH_FALLBACK = os.environ.get('DIALFORGE_ALLOW_LOCAL_AUTH_FALLBACK', '1') != '0'

class DialForgeHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/api/'):
            self._handle_api_get()
            return

        if self.path.startswith(SIP_DEMO_PREFIX):
            self._proxy_sip_demo()
            return

        # If requesting root path, serve landingPage.html
        if self.path == '/' or self.path == '':
            self.path = '/landingPage.html'
        
        # Call parent class method to handle the request
        super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/'):
            self._handle_api_post()
            return

        if self.path.startswith(SIP_DEMO_PREFIX):
            self._proxy_sip_demo()
            return
        self.send_error(404, 'Not found')

    def do_PATCH(self):
        if self.path.startswith('/api/'):
            self._handle_api_patch()
            return

        if self.path.startswith(SIP_DEMO_PREFIX):
            self._proxy_sip_demo()
            return
        self.send_error(404, 'Not found')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _handle_api_get(self):
        path = self.path.split('?', 1)[0]
        if path == '/api/me':
            user = self._user_from_request()
            if not user:
                self._send_json({'error': 'not authenticated'}, status=401)
                return
            if 'user' in user and 'organization' in user:
                self._send_json(user)
                return
            self._send_json(self._public_user_payload(user))
            return

        if path == '/api/call-queue':
            user = self._user_from_request()
            if not user:
                self._send_json({'error': 'not authenticated'}, status=401)
                return
            try:
                self._send_json(self._call_queue_payload(user))
            except (urllib.error.HTTPError, urllib.error.URLError):
                self._send_json(self._local_demo_call_queue_payload(user))
            return

        if path.startswith('/api/call-queue/') and path.endswith('/events'):
            user = self._user_from_request()
            if not user:
                self._send_json({'error': 'not authenticated'}, status=401)
                return

            queue_id = path[len('/api/call-queue/'):-len('/events')].strip('/')
            if not queue_id:
                self._send_json({'error': 'queue id is required'}, status=400)
                return

            try:
                self._send_json(self._call_queue_events_payload(user, queue_id))
            except PermissionError:
                self._send_json({'error': 'call queue item not found'}, status=404)
            except (urllib.error.HTTPError, urllib.error.URLError):
                self._send_json({
                    'events': [],
                    'queue_id': queue_id,
                    'source': 'call_queue_events_unavailable',
                    'generated_at': time.time(),
                })
            return

        self._send_json({'error': 'not found'}, status=404)

    def _handle_api_patch(self):
        path = self.path.split('?', 1)[0]
        if path.startswith('/api/call-queue/'):
            user = self._user_from_request()
            if not user:
                self._send_json({'error': 'not authenticated'}, status=401)
                return

            queue_id = path[len('/api/call-queue/'):].strip('/')
            if not queue_id:
                self._send_json({'error': 'queue id is required'}, status=400)
                return

            try:
                self._send_json(self._update_call_queue_item(user, queue_id, self._read_json_body()))
            except ValueError as error:
                self._send_json({'error': str(error)}, status=400)
            except PermissionError:
                self._send_json({'error': 'call queue item not found'}, status=404)
            except (urllib.error.HTTPError, urllib.error.URLError) as error:
                self._send_json(
                    {'error': 'call queue update failed', 'detail': str(error)},
                    status=502,
                )
            return

        self._send_json({'error': 'not found'}, status=404)

    def _handle_api_post(self):
        path = self.path.split('?', 1)[0]
        if path == '/api/auth/login':
            body = self._read_json_body()
            email = str(body.get('email') or '').strip().lower()
            password = str(body.get('password') or '')
            if not email or not password:
                self._send_json({'error': 'email and password are required'}, status=400)
                return

            supabase_payload = self._try_supabase_login(email, password)
            if supabase_payload:
                self._send_json(supabase_payload)
                return

            user = self._find_demo_user(email)
            if (
                not ALLOW_LOCAL_AUTH_FALLBACK
                or not user
                or str(user.get('password') or '') != password
            ):
                self._send_json({'error': 'invalid email or password'}, status=401)
                return

            payload = self._public_user_payload(user)
            payload['token'] = self._token_for_user(user)
            payload['is_local_dev_auth'] = True
            self._send_json(payload)
            return

        if path == '/api/auth/logout':
            self._send_json({'ok': True})
            return

        self._send_json({'error': 'not found'}, status=404)

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length', '0') or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode('utf-8'))
        except json.JSONDecodeError:
            return {}

    def _send_json(self, payload, status=200):
        response_body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)

    def _load_demo_users(self):
        try:
            with open(DEMO_USERS_PATH, encoding='utf-8') as f:
                users = json.load(f)
        except (OSError, json.JSONDecodeError):
            return []
        return users if isinstance(users, list) else []

    def _load_demo_contacts(self):
        try:
            with open(DEMO_CONTACTS_PATH, encoding='utf-8') as f:
                contacts = json.load(f)
        except (OSError, json.JSONDecodeError):
            return []
        return contacts if isinstance(contacts, list) else []

    def _find_demo_user(self, email):
        for user in self._load_demo_users():
            if str(user.get('email') or '').lower() == email:
                return user
        return None

    def _token_for_user(self, user):
        email = str(user.get('email') or '').lower()
        return f'local-demo:{email}'

    def _user_from_request(self):
        auth_header = self.headers.get('Authorization', '')
        bearer_prefix = 'Bearer '
        local_prefix = 'Bearer local-demo:'
        if auth_header.startswith(local_prefix):
            email = auth_header[len(local_prefix):].strip().lower()
            return self._find_demo_user(email)
        if not auth_header.startswith(bearer_prefix):
            return None
        token = auth_header[len(bearer_prefix):].strip()
        return self._supabase_user_from_token(token)

    def _public_user_payload(self, user):
        organization = user.get('organization') or {}
        public_user = {
            'id': user.get('id'),
            'email': user.get('email'),
            'display_name': user.get('display_name') or user.get('full_name'),
            'full_name': user.get('full_name') or user.get('display_name'),
            'role': user.get('role'),
            'avatar_url': user.get('avatar_url') or '',
            'organization_id': organization.get('id'),
        }
        return {
            'user': public_user,
            'organization': organization,
            'source': 'local_product_api',
            'generated_at': time.time(),
        }

    def _try_supabase_login(self, email, password):
        if not SUPABASE_URL or not SUPABASE_ANON_KEY:
            return None
        try:
            response = self._supabase_auth_request(
                '/token?grant_type=password',
                method='POST',
                body={'email': email, 'password': password},
                key=SUPABASE_ANON_KEY,
                bearer=SUPABASE_ANON_KEY,
            )
        except urllib.error.HTTPError:
            return None
        except urllib.error.URLError:
            return None

        access_token = response.get('access_token')
        auth_user = response.get('user')
        if not access_token or not auth_user:
            return None

        payload = self._public_supabase_user_payload(auth_user)
        payload['token'] = access_token
        payload['is_local_dev_auth'] = False
        return payload

    def _supabase_user_from_token(self, token):
        if not SUPABASE_URL or not SUPABASE_ANON_KEY:
            return None
        try:
            auth_user = self._supabase_auth_request(
                '/user',
                method='GET',
                key=SUPABASE_ANON_KEY,
                bearer=token,
            )
        except (urllib.error.HTTPError, urllib.error.URLError):
            return None
        return self._public_supabase_user_payload(auth_user)

    def _public_supabase_user_payload(self, auth_user):
        user_id = auth_user.get('id')
        email = str(auth_user.get('email') or '').lower()
        metadata = auth_user.get('user_metadata') or {}
        db_user = self._find_supabase_public_user(user_id, email)
        organization = self._find_supabase_organization(db_user.get('organization_id'))
        org_name = organization.get('name') or metadata.get('organization_name') or ''
        display_name = (
            metadata.get('display_name')
            or metadata.get('full_name')
            or metadata.get('name')
            or (email.split('@')[0].replace('.', ' ').title() if email else '')
        )

        public_user = {
            'id': user_id,
            'email': email,
            'display_name': display_name,
            'full_name': metadata.get('full_name') or display_name,
            'role': metadata.get('role') or db_user.get('role') or '',
            'avatar_url': metadata.get('avatar_url') or metadata.get('picture') or '',
            'organization_id': db_user.get('organization_id'),
        }
        public_org = {
            'id': organization.get('id') or db_user.get('organization_id') or metadata.get('organization_id') or '',
            'name': org_name,
            'slug': metadata.get('organization_slug') or self._slugify(org_name),
            'plan': metadata.get('organization_plan') or 'starter',
        }
        return {
            'user': public_user,
            'organization': public_org,
            'source': 'supabase_auth',
            'generated_at': time.time(),
        }

    def _find_supabase_public_user(self, user_id, email):
        if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
            return {}
        if user_id:
            rows = self._supabase_rest_select('users', f'id=eq.{urllib.parse.quote(str(user_id), safe="")}')
            if rows:
                return rows[0]
        if email:
            rows = self._supabase_rest_select('users', f'email=eq.{urllib.parse.quote(email, safe="")}')
            if rows:
                return rows[0]
        return {}

    def _find_supabase_organization(self, organization_id):
        if not organization_id or not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
            return {}
        rows = self._supabase_rest_select(
            'organizations',
            f'id=eq.{urllib.parse.quote(str(organization_id), safe="")}',
        )
        return rows[0] if rows else {}

    def _supabase_rest_select(self, table, query):
        try:
            return self._supabase_rest_request(
                f'/{table}?select=*&{query}&limit=1',
                method='GET',
            )
        except (urllib.error.HTTPError, urllib.error.URLError):
            return []

    def _call_queue_payload(self, user_context):
        organization_id = self._organization_id_from_user_context(user_context)
        if not organization_id:
            return {
                'queue': [],
                'organization_id': '',
                'source': 'supabase_call_queue',
                'generated_at': time.time(),
            }

        queue_rows = self._supabase_rest_request(
            '/call_queue?select=*&'
            f'organization_id=eq.{urllib.parse.quote(str(organization_id), safe="")}'
            '&order=priority.desc,scheduled_at.asc,created_at.asc',
            method='GET',
        )
        contact_ids = [
            str(row.get('contact_id')) for row in queue_rows if row.get('contact_id') is not None
        ]
        contacts_by_id = {}
        if contact_ids:
            contacts = self._supabase_rest_request(
                f'/contacts?select=*&id=in.({",".join(contact_ids)})',
                method='GET',
            )
            contacts_by_id = {str(contact.get('id')): contact for contact in contacts}

        demo_metadata = self._demo_contact_metadata()
        return {
            'queue': [
                self._public_call_queue_item(row, contacts_by_id, demo_metadata)
                for row in queue_rows
            ],
            'organization_id': organization_id,
            'source': 'supabase_call_queue',
            'generated_at': time.time(),
        }

    def _public_call_queue_item(self, row, contacts_by_id, demo_metadata):
        contact = contacts_by_id.get(str(row.get('contact_id')), {})
        metadata = self._metadata_for_contact(contact, demo_metadata)
        priority_value = row.get('priority') or 0
        return {
            'id': row.get('id'),
            'queue_id': row.get('id'),
            'contact_id': row.get('contact_id'),
            'organization_id': row.get('organization_id'),
            'name': contact.get('name') or metadata.get('name') or 'Unknown Prospect',
            'email': contact.get('email') or metadata.get('email') or '',
            'phone': contact.get('phone') or metadata.get('phone') or '',
            'company': contact.get('company') or metadata.get('company') or '',
            'title': metadata.get('title') or 'PROSPECT',
            'status': self._ui_queue_status(row.get('status'), metadata),
            'db_status': row.get('status') or '',
            'priority': metadata.get('priority') or self._priority_label(priority_value),
            'priority_value': priority_value,
            'call_mode': row.get('call_mode') or '',
            'scheduled_at': row.get('scheduled_at'),
            'created_at': row.get('created_at'),
            'avatar': metadata.get('avatar_url') or '',
            'source': metadata.get('source') or 'supabase',
        }

    def _update_call_queue_item(self, user_context, queue_id, body):
        organization_id = self._organization_id_from_user_context(user_context)
        if not organization_id:
            raise PermissionError()

        queue_rows = self._supabase_rest_request(
            f'/call_queue?select=*&id=eq.{urllib.parse.quote(str(queue_id), safe="")}&limit=1',
            method='GET',
        )
        if not queue_rows or queue_rows[0].get('organization_id') != organization_id:
            raise PermissionError()

        ui_status = str(body.get('status') or body.get('db_status') or '').lower()
        db_status = self._db_queue_status(ui_status)
        previous_row = queue_rows[0]
        rows = self._supabase_rest_request(
            f'/call_queue?id=eq.{urllib.parse.quote(str(queue_id), safe="")}',
            method='PATCH',
            body={'status': db_status},
            extra_headers={'Prefer': 'return=representation'},
        )
        if not rows:
            raise PermissionError()

        event = self._record_call_queue_event(
            user_context=user_context,
            previous_row=previous_row,
            updated_row=rows[0],
            ui_status=ui_status,
            body=body,
        )

        contact_id = rows[0].get('contact_id')
        contacts_by_id = {}
        if contact_id is not None:
            contacts = self._supabase_rest_request(
                f'/contacts?select=*&id=eq.{urllib.parse.quote(str(contact_id), safe="")}&limit=1',
                method='GET',
            )
            contacts_by_id = {str(contact.get('id')): contact for contact in contacts}

        return {
            'item': self._public_call_queue_item(
                rows[0],
                contacts_by_id,
                self._demo_contact_metadata(),
            ),
            'event': event,
            'source': 'supabase_call_queue_update',
            'generated_at': time.time(),
        }

    def _call_queue_events_payload(self, user_context, queue_id):
        organization_id = self._organization_id_from_user_context(user_context)
        if not organization_id:
            raise PermissionError()

        queue_rows = self._supabase_rest_request(
            f'/call_queue?select=*&id=eq.{urllib.parse.quote(str(queue_id), safe="")}&limit=1',
            method='GET',
        )
        if not queue_rows or queue_rows[0].get('organization_id') != organization_id:
            raise PermissionError()

        events = self._supabase_rest_request(
            f'/call_queue_events?select=*&call_queue_id=eq.{urllib.parse.quote(str(queue_id), safe="")}'
            '&order=created_at.desc',
            method='GET',
        )
        return {
            'events': events,
            'queue_id': queue_id,
            'source': 'supabase_call_queue_events',
            'generated_at': time.time(),
        }

    def _record_call_queue_event(self, user_context, previous_row, updated_row, ui_status, body):
        payload = self._call_queue_event_payload(
            user_context=user_context,
            previous_row=previous_row,
            updated_row=updated_row,
            ui_status=ui_status,
            body=body,
        )
        try:
            rows = self._supabase_rest_request(
                '/call_queue_events',
                method='POST',
                body=payload,
                extra_headers={'Prefer': 'return=representation'},
            )
        except (urllib.error.HTTPError, urllib.error.URLError):
            return {
                'persisted': False,
                'reason': 'call_queue_events table is not available yet',
                'pending_migration': 'dial-forge-ai/ai-pipeline/supabase/migrations/002_call_queue_events.sql',
                'payload': payload,
            }
        return {
            'persisted': True,
            'row': rows[0] if rows else payload,
        }

    def _call_queue_event_payload(self, user_context, previous_row, updated_row, ui_status, body):
        return {
            'organization_id': updated_row.get('organization_id'),
            'call_queue_id': updated_row.get('id'),
            'contact_id': updated_row.get('contact_id'),
            'actor_user_id': self._actor_user_id_from_context(user_context),
            'event_type': self._event_type_for_status(ui_status),
            'outcome': body.get('outcome') or ui_status or None,
            'ui_status': ui_status or None,
            'db_status': updated_row.get('status'),
            'duration_seconds': self._integer_or_none(body.get('duration_seconds')),
            'voicemail_title': body.get('voicemail_title') or None,
            'payload': {
                'previous_db_status': previous_row.get('status'),
                'requested_status': ui_status,
                'action': body.get('action') or None,
                'source': body.get('source') or 'power_dialer_ui',
            },
        }

    def _event_type_for_status(self, ui_status):
        status = str(ui_status or '').lower()
        event_types = {
            'calling': 'dial.started',
            'connected': 'dial.connected',
            'voicemail': 'dial.voicemail',
            'skipped': 'dial.skipped',
            'hungup': 'dial.hungup',
            'completed': 'dial.completed',
            'failed': 'dial.failed',
            'queued': 'queue.queued',
            'waiting': 'queue.waiting',
        }
        return event_types.get(status, 'queue.status_changed')

    def _actor_user_id_from_context(self, user_context):
        user = user_context.get('user') or {}
        user_id = user.get('id') or user_context.get('id')
        return user_id if user_id and not str(user_id).startswith('usr_demo_') else None

    def _integer_or_none(self, value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _metadata_for_contact(self, contact, demo_metadata):
        keys = [
            str(contact.get('email') or '').lower(),
            str(contact.get('phone') or ''),
            f"{contact.get('name') or ''}|{contact.get('company') or ''}".lower(),
        ]
        for key in keys:
            if key and key in demo_metadata:
                return demo_metadata[key]
        return {}

    def _demo_contact_metadata(self):
        metadata = {}
        for contact in self._load_demo_contacts():
            keys = [
                str(contact.get('email') or '').lower(),
                str(contact.get('phone') or ''),
                f"{contact.get('name') or ''}|{contact.get('company') or ''}".lower(),
            ]
            for key in keys:
                if key:
                    metadata[key] = contact
        return metadata

    def _local_demo_call_queue_payload(self, user_context):
        organization = self._organization_from_user_context(user_context)
        organization_id = organization.get('id') or ''
        organization_name = organization.get('name') or ''
        contacts = [
            contact for contact in self._load_demo_contacts()
            if not organization_name or contact.get('organization_name') == organization_name
        ]
        queue = []
        for index, contact in enumerate(contacts, start=1):
            priority = contact.get('priority') or 'low'
            queue.append({
                'id': index,
                'queue_id': index,
                'contact_id': '',
                'organization_id': organization_id,
                'name': contact.get('name') or 'Unknown Prospect',
                'email': contact.get('email') or '',
                'phone': contact.get('phone') or '',
                'company': contact.get('company') or '',
                'title': contact.get('title') or 'PROSPECT',
                'status': contact.get('status') or 'waiting',
                'priority': priority,
                'priority_value': {'high': 3, 'medium': 2, 'low': 1}.get(priority, 0),
                'call_mode': 'auto_dialer',
                'scheduled_at': '',
                'created_at': '',
                'avatar': contact.get('avatar_url') or '',
                'source': contact.get('source') or 'local_demo_contacts',
            })
        return {
            'queue': queue,
            'organization_id': organization_id,
            'source': 'local_demo_call_queue',
            'generated_at': time.time(),
        }

    def _organization_id_from_user_context(self, user_context):
        organization = self._organization_from_user_context(user_context)
        organization_id = organization.get('id') or user_context.get('organization_id')
        try:
            return int(organization_id)
        except (TypeError, ValueError):
            return None

    def _organization_from_user_context(self, user_context):
        if 'organization' in user_context:
            return user_context.get('organization') or {}
        if 'user' in user_context and 'organization' in user_context:
            return user_context.get('organization') or {}
        return {}

    def _priority_label(self, priority_value):
        try:
            priority_value = int(priority_value)
        except (TypeError, ValueError):
            priority_value = 0
        if priority_value >= 3:
            return 'high'
        if priority_value == 2:
            return 'medium'
        return 'low'

    def _ui_queue_status(self, db_status, metadata):
        if db_status == 'queued':
            return metadata.get('status') or 'waiting'
        return db_status or metadata.get('status') or 'waiting'

    def _db_queue_status(self, ui_status):
        status = str(ui_status or '').lower()
        if status in ('queued', 'waiting', 'calling'):
            return 'queued'
        if status in ('completed', 'connected', 'voicemail'):
            return 'completed'
        if status in ('failed', 'skipped', 'hungup', 'no_answer', 'busy', 'declined', 'dropped'):
            return 'failed'
        raise ValueError('unsupported call queue status')

    def _supabase_auth_request(self, path, method='GET', body=None, key=None, bearer=None):
        return self._supabase_request(f'{SUPABASE_URL}/auth/v1{path}', method, body, key, bearer)

    def _supabase_rest_request(self, path, method='GET', body=None, extra_headers=None):
        return self._supabase_request(
            f'{SUPABASE_URL}/rest/v1{path}',
            method,
            body,
            SUPABASE_SERVICE_ROLE_KEY,
            SUPABASE_SERVICE_ROLE_KEY,
            extra_headers,
        )

    def _supabase_request(self, url, method, body, key, bearer, extra_headers=None):
        payload = json.dumps(body).encode() if body is not None else None
        headers = {
            'apikey': key or '',
            'Authorization': f'Bearer {bearer or key or ""}',
            'Content-Type': 'application/json',
            **(extra_headers or {}),
        }
        request = urllib.request.Request(url, data=payload, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read().decode('utf-8')
            return json.loads(raw) if raw else {}

    def _slugify(self, value):
        return '-'.join(str(value or '').lower().split())

    def _proxy_sip_demo(self):
        upstream_path = self.path[len(SIP_DEMO_PREFIX):] or '/'
        target_url = f'{SIP_DEMO_BASE_URL}{upstream_path}'
        length = int(self.headers.get('Content-Length', '0') or 0)
        body = self.rfile.read(length) if length else None
        headers = {
            FRONTEND_PROXY_HEADER: '1',
        }
        content_type = self.headers.get('Content-Type')
        if content_type:
            headers['Content-Type'] = content_type

        request = urllib.request.Request(
            target_url,
            data=body,
            headers=headers,
            method=self.command,
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                response_body = response.read()
                self.send_response(response.status)
                self._copy_proxy_headers(response.headers, len(response_body))
                self.end_headers()
                self.wfile.write(response_body)
        except urllib.error.HTTPError as e:
            response_body = e.read()
            self.send_response(e.code)
            self._copy_proxy_headers(e.headers, len(response_body))
            self.end_headers()
            self.wfile.write(response_body)
        except urllib.error.URLError as e:
            response_body = json.dumps({
                'error': 'SIP demo server is not reachable',
                'detail': str(e.reason),
            }).encode()
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)

    def _copy_proxy_headers(self, upstream_headers, body_length):
        content_type = upstream_headers.get('Content-Type', 'application/json')
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(body_length))
        self.send_header('Cache-Control', 'no-store')


class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

def get_local_ip():
    """Get the local IP address of this machine"""
    try:
        # Connect to an external host (doesn't actually send data)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return socket.gethostbyname(socket.gethostname())

def main():
    # Navigate to parent directory (dial-forge-front-end/)
    script_dir = Path(__file__).parent.absolute()
    project_root = script_dir.parent
    
    # Change to project root so server serves from correct location
    os.chdir(project_root)
    
    # Create and run server
    with ThreadingTCPServer((BIND_ADDRESS, PORT), DialForgeHandler) as httpd:
        # Get local IP
        local_ip = get_local_ip()
        
        # Print startup information
        print("\n" + "="*50)
        print("DialForge local server running")
        print("="*50)
        print(f"Local:   http://localhost:{PORT}")
        print(f"Network: http://{local_ip}:{PORT}")
        print(f"Home:    landingPage.html")
        print(f"SIP API: {SIP_DEMO_PREFIX}/* -> {SIP_DEMO_BASE_URL}/*")
        print("="*50)
        print("Press Ctrl+C to stop the server\n")

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\nServer stopped.")

if __name__ == '__main__':
    main()
