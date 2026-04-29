import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';

interface ProviderCfg {
  label?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

interface MediaCfg {
  enabled?: boolean;
  visionProvider?: 'local' | 'external';
  sttProvider?: 'local' | 'external';
  vision?: ProviderCfg;
  stt?: ProviderCfg;
  workerConcurrency?: number;
  workerPollIntervalMs?: number;
  workerMaxPollIntervalMs?: number;
  fallbackToExternal?: boolean;
  maxFileSizeBytes?: number;
  stalledJobTimeoutMs?: number;
  lockedByInfra?: string[];
}

@Component({
  selector: 'app-models',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [`
    .section { margin-bottom: 28px; }
    .section-title { font-size: 13px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
    .field { margin-bottom: 14px; }
    .field label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }
    .field input, .field select { width: 100%; }
    .locked-badge { display: inline-block; margin-left: 6px; font-size: 11px; color: var(--text-muted); background: var(--bg-elevated); border-radius: 4px; padding: 1px 6px; vertical-align: middle; }
    .actions { display: flex; gap: 10px; align-items: center; margin-top: 20px; }
    .save-error { color: var(--error); font-size: 13px; }
    .save-ok { color: var(--success); font-size: 13px; }
  `],
  template: `
    <div class="page-header" style="margin-bottom:16px;">
      <div class="card-title">Models &amp; Media Embedding</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">
        Configure local AI providers for image captioning and speech-to-text.
      </div>
    </div>

    @if (loading()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (loadError()) {
      <div class="alert alert-error">{{ loadError() }}</div>
    } @else {
      <!-- Master switch -->
      <div class="section">
        <div class="field">
          <label>
            <input type="checkbox" [(ngModel)]="form.enabled" [disabled]="isLocked('enabled')" />
            Enable media embedding
            @if (isLocked('enabled')) { <span class="locked-badge">env</span> }
          </label>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
            When enabled, uploaded images/audio/video are automatically captioned and embedded. Requires Ollama and Whisper services.
          </div>
        </div>
      </div>

      <!-- Vision (captioning) -->
      <div class="section">
        <div class="section-title">Vision (Image Captioning)</div>
        <div class="field">
          <label>Provider
            @if (isLocked('visionProvider')) { <span class="locked-badge">env</span> }
          </label>
          <select [(ngModel)]="form.visionProvider" [disabled]="isLocked('visionProvider')">
            <option value="local">Local (Ollama)</option>
            <option value="external">External (OpenAI-compatible)</option>
          </select>
        </div>
        <div class="field">
          <label>Endpoint URL
            @if (isLocked('vision.baseUrl')) { <span class="locked-badge">env</span> }
          </label>
          <input type="url" [(ngModel)]="form.vision!.baseUrl"
            [disabled]="isLocked('vision.baseUrl')"
            placeholder="http://ollama.ythril.svc.cluster.local:11434" />
        </div>
        <div class="field">
          <label>Model
            @if (isLocked('vision.model')) { <span class="locked-badge">env</span> }
          </label>
          <input type="text" [(ngModel)]="form.vision!.model"
            [disabled]="isLocked('vision.model')"
            placeholder="moondream2" />
        </div>
        <div class="field">
          <label>API Key (optional)
            @if (isLocked('vision.apiKey')) { <span class="locked-badge">env</span> }
          </label>
          <input type="password" [(ngModel)]="visionApiKeyInput"
            [disabled]="isLocked('vision.apiKey')"
            placeholder="Leave blank to keep current value" />
        </div>
      </div>

      <!-- STT -->
      <div class="section">
        <div class="section-title">Speech-to-Text (Audio / Video)</div>
        <div class="field">
          <label>Provider
            @if (isLocked('sttProvider')) { <span class="locked-badge">env</span> }
          </label>
          <select [(ngModel)]="form.sttProvider" [disabled]="isLocked('sttProvider')">
            <option value="local">Local (faster-whisper-server)</option>
            <option value="external">External (OpenAI-compatible)</option>
          </select>
        </div>
        <div class="field">
          <label>Endpoint URL
            @if (isLocked('stt.baseUrl')) { <span class="locked-badge">env</span> }
          </label>
          <input type="url" [(ngModel)]="form.stt!.baseUrl"
            [disabled]="isLocked('stt.baseUrl')"
            placeholder="http://whisper.ythril.svc.cluster.local:8000" />
        </div>
        <div class="field">
          <label>Model
            @if (isLocked('stt.model')) { <span class="locked-badge">env</span> }
          </label>
          <input type="text" [(ngModel)]="form.stt!.model"
            [disabled]="isLocked('stt.model')"
            placeholder="base" />
        </div>
        <div class="field">
          <label>API Key (optional)
            @if (isLocked('stt.apiKey')) { <span class="locked-badge">env</span> }
          </label>
          <input type="password" [(ngModel)]="sttApiKeyInput"
            [disabled]="isLocked('stt.apiKey')"
            placeholder="Leave blank to keep current value" />
        </div>
      </div>

      <!-- Advanced -->
      <div class="section">
        <div class="section-title">Advanced</div>
        <div class="field">
          <label>Fallback to external on error
            @if (isLocked('fallbackToExternal')) { <span class="locked-badge">env</span> }
          </label>
          <input type="checkbox" [(ngModel)]="form.fallbackToExternal" [disabled]="isLocked('fallbackToExternal')" />
        </div>
        <div class="field">
          <label>Max file size for embedding (bytes)
            @if (isLocked('maxFileSizeBytes')) { <span class="locked-badge">env</span> }
          </label>
          <input type="number" [(ngModel)]="form.maxFileSizeBytes" [disabled]="isLocked('maxFileSizeBytes')" min="1" />
        </div>
        <div class="field">
          <label>Worker concurrency
            @if (isLocked('workerConcurrency')) { <span class="locked-badge">env</span> }
          </label>
          <input type="number" [(ngModel)]="form.workerConcurrency" [disabled]="isLocked('workerConcurrency')" min="1" max="16" />
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-primary" (click)="save()" [disabled]="saving()">
          {{ saving() ? 'Saving…' : 'Save' }}
        </button>
        <span class="save-error">{{ saveError() }}</span>
        <span class="save-ok">{{ saveOk() }}</span>
      </div>
    }
  `,
})
export class ModelsComponent implements OnInit {
  private readonly http = inject(HttpClient);

  loading = signal(true);
  loadError = signal<string | null>(null);
  saving = signal(false);
  saveError = signal('');
  saveOk = signal('');

  form: MediaCfg = { vision: {}, stt: {} };
  lockedByInfra: string[] = [];
  visionApiKeyInput = '';
  sttApiKeyInput = '';

  ngOnInit(): void {
    this.http.get<MediaCfg>('/api/admin/media-config').subscribe({
      next: cfg => {
        this.lockedByInfra = cfg.lockedByInfra ?? [];
        this.form = { vision: {}, stt: {}, ...cfg };
        this.form.vision = { ...cfg.vision };
        this.form.stt = { ...cfg.stt };
        // API returns masked apiKey — clear so user must explicitly set a new one
        if (this.form.vision) this.form.vision.apiKey = undefined;
        if (this.form.stt) this.form.stt.apiKey = undefined;
        this.loading.set(false);
      },
      error: err => {
        this.loadError.set(`Failed to load configuration: ${err?.message ?? 'Unknown error'}`);
        this.loading.set(false);
      },
    });
  }

  isLocked(field: string): boolean {
    return this.lockedByInfra.includes(field);
  }

  save(): void {
    this.saving.set(true);
    this.saveError.set('');
    this.saveOk.set('');

    const payload: MediaCfg = {
      enabled: this.form.enabled,
      visionProvider: this.form.visionProvider,
      sttProvider: this.form.sttProvider,
      vision: {
        baseUrl: this.form.vision?.baseUrl,
        model: this.form.vision?.model,
        label: this.form.vision?.label,
        // Only include apiKey if the user typed something
        ...(this.visionApiKeyInput ? { apiKey: this.visionApiKeyInput } : {}),
      },
      stt: {
        baseUrl: this.form.stt?.baseUrl,
        model: this.form.stt?.model,
        label: this.form.stt?.label,
        ...(this.sttApiKeyInput ? { apiKey: this.sttApiKeyInput } : {}),
      },
      fallbackToExternal: this.form.fallbackToExternal,
      maxFileSizeBytes: this.form.maxFileSizeBytes,
      workerConcurrency: this.form.workerConcurrency,
      workerPollIntervalMs: this.form.workerPollIntervalMs,
      workerMaxPollIntervalMs: this.form.workerMaxPollIntervalMs,
      stalledJobTimeoutMs: this.form.stalledJobTimeoutMs,
    };

    // Remove undefined keys to keep the payload clean
    const body = JSON.parse(JSON.stringify(payload)) as MediaCfg;

    this.http.patch<{ ok: boolean; config: MediaCfg }>('/api/admin/media-config', body).subscribe({
      next: () => {
        this.saveOk.set('Saved');
        this.visionApiKeyInput = '';
        this.sttApiKeyInput = '';
        this.saving.set(false);
        setTimeout(() => this.saveOk.set(''), 3000);
      },
      error: err => {
        const detail = err?.error?.error ?? err?.message ?? 'Unknown error';
        this.saveError.set(`Save failed: ${detail}`);
        this.saving.set(false);
      },
    });
  }
}
