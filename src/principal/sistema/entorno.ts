/**
 * El entorno del PC: lo que NO es del programa pero decide si Overwolf puede leer el juego.
 *
 * Causas típicas de «el programa funciona pero no recibe datos» que sólo se ven mirando la máquina:
 *   · VALORANT corre como administrador y Easy HUD no (Overwolf no puede leerlo);
 *   · un antivirus que corta a Overwolf;
 *   · el Overwolf de escritorio instalado (aunque no esté abierto);
 *   · el programa lanzado como portable desde una carpeta temporal.
 * Todo se lee en una sola llamada a PowerShell, sin pedir permisos.
 */

import { execFile } from 'node:child_process';
import { arch, release, version } from 'node:os';

export interface Entorno {
  so: string;
  arquitectura: string;
  /** El programa corre como administrador. */
  esAdmin: boolean | null;
  /** VALORANT corre como administrador (`null` = VALORANT no está abierto o no se pudo saber). */
  valorantElevado: boolean | null;
  antivirus: string[];
  /** Carpetas del Overwolf de escritorio que existen en el PC. */
  overwolfInstalado: string[];
  /** Cuántos procesos Overwolf hay abiertos ahora. */
  overwolfAbierto: number;
  ejecutable: string;
  /** Se lanzó desde una carpeta temporal (el portable): no es una instalación. */
  desdeTemporal: boolean;
}

const GUION = `
$ErrorActionPreference = 'SilentlyContinue'
$o = [ordered]@{}
$o.admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$p = Get-Process -Name 'VALORANT-Win64-Shipping' | Select-Object -First 1
if ($p) { try { $null = $p.MainModule.FileName; $o.valorantElevado = $false } catch { $o.valorantElevado = $true } } else { $o.valorantElevado = $null }
$o.antivirus = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object { $_.displayName })
$rutas = @("$env:LOCALAPPDATA\\Overwolf", "$env:ProgramFiles\\Overwolf", "\${env:ProgramFiles(x86)}\\Overwolf")
$o.overwolf = @($rutas | Where-Object { Test-Path $_ })
$o.overwolfAbierto = @(Get-Process -Name 'Overwolf','OverwolfBrowser' -ErrorAction SilentlyContinue).Count
$o | ConvertTo-Json -Compress
`;

/** Pasa la salida JSON de PowerShell a `Entorno` (puro: se prueba). */
export function leeEntorno(json: string, ejecutable: string): Entorno {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v === 'object' && v !== null) o = v as Record<string, unknown>;
  } catch {
    /* sin datos de PowerShell: queda lo que sabe Node */
  }
  const lista = (x: unknown): string[] => (Array.isArray(x) ? x.filter((e): e is string => typeof e === 'string') : typeof x === 'string' ? [x] : []);
  const logico = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null);
  return {
    so: `${version()} (${release()})`,
    arquitectura: arch(),
    esAdmin: logico(o.admin),
    valorantElevado: logico(o.valorantElevado),
    antivirus: lista(o.antivirus).slice(0, 6),
    overwolfInstalado: lista(o.overwolf).slice(0, 4),
    overwolfAbierto: typeof o.overwolfAbierto === 'number' ? o.overwolfAbierto : 0,
    ejecutable,
    desdeTemporal: /[\\/]temp[\\/]/i.test(ejecutable),
  };
}

export function leeEntornoDelPc(ejecutable: string): Promise<Entorno> {
  if (process.platform !== 'win32') return Promise.resolve(leeEntorno('{}', ejecutable));
  const codificado = Buffer.from(GUION, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', codificado],
      { windowsHide: true, timeout: 20_000 },
      (_e, stdout) => resolve(leeEntorno(String(stdout ?? ''), ejecutable)),
    );
  });
}
