import React from 'react';
import { FolderLock, Info, MonitorPlay, Network, ShieldCheck } from 'lucide-react';

interface VirtualCameraGuideProps {
  onOpenCleanFeed: () => void;
  canOpenCleanFeed: boolean;
}

export const VirtualCameraGuide: React.FC<VirtualCameraGuideProps> = ({
  onOpenCleanFeed,
  canOpenCleanFeed,
}) => {
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Browser Limitations &amp; Windows Virtual Camera Integration
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
          ZEN CAM runs completely inside standard web browsers with zero external cloud document
          storage. Below is an accurate summary of what browser APIs allow directly on Windows 10
          and what additional native component is required for a system-wide virtual webcam.
        </p>
      </div>

      {/* Section 1: System-wide webcam limitation */}
      <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
        <div className="flex items-start gap-3">
          <MonitorPlay className="mt-0.5 h-5 w-5 text-blue-700 dark:text-blue-400 shrink-0" />
          <div className="space-y-3">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              1. Why a Browser Video Preview Is Not Automatically a Windows System Webcam
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              Web browsers operate inside a strict OS security sandbox. A web page receiving a
              WebRTC stream can display live video inside a browser tab, capture high-resolution
              still photos, and save files locally, but it <strong>cannot register a Windows DirectShow
              or Media Foundation capture device</strong>. Other applications (such as e-Sevai
              biometric/photo portals in separate tabs, Zoom, Microsoft Teams, or desktop ID photo
              software) only list hardware or virtual camera drivers registered with Windows.
            </p>

            <div className="grid grid-cols-1 gap-4 pt-2 md:grid-cols-2">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-[#0B0F17]">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Option A: Use Today via OBS Studio Virtual Camera
                </h4>
                <ol className="mt-2 space-y-1.5 text-xs text-slate-600 dark:text-slate-300 list-decimal pl-4 leading-relaxed">
                  <li>Install free open-source OBS Studio on Windows 10.</li>
                  <li>
                    In ZEN CAM Live Camera, switch to <strong>Clean Feed Mode</strong> so only the
                    video fills the viewport.
                  </li>
                  <li>
                    In OBS Studio, add a <strong>Window Capture</strong> source targeting the ZEN
                    CAM browser window and crop any browser chrome.
                  </li>
                  <li>
                    Click <strong>Start Virtual Camera</strong> in OBS. Select{' '}
                    <span className="font-mono">OBS Virtual Camera</span> inside your e-Sevai portal
                    or desktop app.
                  </li>
                </ol>
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={onOpenCleanFeed}
                    disabled={!canOpenCleanFeed}
                    className="h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                  >
                    {canOpenCleanFeed
                      ? 'Switch to Clean Feed Mode Now'
                      : 'Pair & Start Stream to Use Clean Feed'}
                  </button>
                </div>
              </div>

              <div className="rounded-md border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-[#0B0F17]">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Option B: Native Windows Virtual Camera Bridge (Required Architecture)
                </h4>
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  To expose ZEN CAM directly as a standalone Windows 10 webcam named &ldquo;ZEN CAM
                  Virtual Camera&rdquo; without OBS, you would pair this web app with a local
                  Windows native helper composed of two parts:
                </p>
                <ul className="mt-2 space-y-1.5 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4 leading-relaxed">
                  <li>
                    <strong>Windows Virtual Camera Driver:</strong> A signed DirectShow filter
                    (required for Windows 10) such as UnityCapture, OBS VirtualCam DirectShow DLL,
                    or a custom C++ DirectShow source filter (Windows 11 also supports{' '}
                    <span className="font-mono">MFCreateVirtualCamera</span>).
                  </li>
                  <li>
                    <strong>Local Receiver Service:</strong> A native C++/C#/Rust/Electron tray app
                    joining the exact same ZEN CAM WebRTC signaling room, decoding raw NV12/RGB
                    video frames, and writing them into the DirectShow shared-memory ring buffer.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Local Documents/ZEN CAM storage */}
      <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
        <div className="flex items-start gap-3">
          <FolderLock className="mt-0.5 h-5 w-5 text-blue-700 dark:text-blue-400 shrink-0" />
          <div className="space-y-2">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              2. Saving Locally to Documents/ZEN CAM (Zero Cloud Upload)
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              For security, Windows browsers cannot write silently to{' '}
              <span className="font-mono">C:\Users\&lt;User&gt;\Documents\ZEN CAM</span> without
              explicit user folder selection. In Microsoft Edge and Google Chrome on Windows 10, ZEN
              CAM uses the native <strong>File System Access API</strong>: click{' '}
              <strong>Link Documents/ZEN CAM Folder</strong> once in the Document Desk, select your{' '}
              <span className="font-mono">Documents</span> folder, and ZEN CAM automatically creates
              and writes JPG and PDF scans directly into{' '}
              <span className="font-mono">Documents/ZEN CAM</span>. In Firefox, files fall back to
              standard browser downloads.
            </p>
          </div>
        </div>
      </section>

      {/* Section 3: Cross-network wireless pairing & privacy */}
      <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="flex items-start gap-3">
            <Network className="mt-0.5 h-5 w-5 text-blue-700 dark:text-blue-400 shrink-0" />
            <div className="space-y-1.5">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Cross-Network Wireless Connectivity
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Signaling uses the app&apos;s WebSocket endpoint so your Windows PC (Ethernet/Wi-Fi)
                and Android phone (4G/5G mobile data or separate Wi-Fi) do not need the same local
                network. WebRTC establishes direct peer-to-peer media and data via STUN. If a mobile
                carrier enforces strict symmetric NAT, configure your own TURN server under{' '}
                <strong>Pair Device → Network / TURN Settings</strong>.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 text-blue-700 dark:text-blue-400 shrink-0" />
            <div className="space-y-1.5">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Customer Document Privacy Guarantee
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Customer Aadhaar cards, certificates, and applications are never uploaded to cloud
                storage or written to the signaling server. Every scan travels directly from Android
                to Windows over an end-to-end DTLS-encrypted WebRTC DataChannel, and PDF/JPG
                generation happens strictly inside your local Windows browser memory.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <Info className="h-4 w-4 shrink-0" />
        <span>
          Android Chrome requires HTTPS (or localhost) for camera access and PWA installation.
        </span>
      </div>
    </div>
  );
};
