// ============================================================
// ASN.1 DER PARSER — PKCS#7 constructed OCTET STRING
// Extracted from fattura-v3.jsx
// ============================================================

function pLen(d: Uint8Array, o: number): { l: number; o: number } {
  const b = d[o];
  if (b < 0x80) return { l: b, o: o + 1 };
  if (b === 0x80) return { l: -1, o: o + 1 };
  const n = b & 0x7f;
  let l = 0;
  for (let i = 0; i < n; i++) l = l * 256 + d[o + 1 + i];
  return { l, o: o + 1 + n };
}

function exOct(d: Uint8Array, o: number, e: number): { c: Uint8Array[]; o: number } {
  const r: Uint8Array[] = [];
  while (o < e && o < d.length) {
    const t = d[o];
    if (t === 0 && o + 1 < d.length && d[o + 1] === 0) { o += 2; break; }
    o++;
    const { l, o: no } = pLen(d, o);
    o = no;
    if (l === -1) { const i = exOct(d, o, e); r.push(...i.c); o = i.o; }
    else if (t === 0x04) { r.push(d.slice(o, o + l)); o += l; }
    else if (t === 0x24 || (t & 0x20)) { const i = exOct(d, o, o + l); r.push(...i.c); o += l; }
    else o += Math.max(0, l);
  }
  return { c: r, o };
}

function extractP7M(buf: ArrayBuffer): string {
  let d = new Uint8Array(buf);

  if (d[0] !== 0x30) {
    try {
      const text = new TextDecoder("ascii").decode(d).replace(/[\r\n\s]/g, "");
      if (/^[A-Za-z0-9+/]+=*$/.test(text.substring(0, 100))) {
        d = Uint8Array.from(atob(text), c => c.charCodeAt(0));
      }
    } catch { /* not base64 */ }
    if (d[0] !== 0x30) {
      try {
        const text = new TextDecoder("ascii").decode(new Uint8Array(buf));
        const b64 = text.replace(/-----[^-]+-----/g, "").replace(/[\r\n\s]/g, "");
        d = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      } catch { /* not PEM */ }
    }
  }

  const oid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01];
  let oi = -1;
  for (let i = 0; i < Math.min(d.length, 2000); i++) {
    let m = true;
    for (let j = 0; j < oid.length; j++) if (d[i + j] !== oid[j]) { m = false; break; }
    if (m) { oi = i; break; }
  }
  if (oi < 0) throw new Error("OID pkcs7-data non trovato");
  let p = oi + oid.length;
  if (d[p] === 0xa0) { p++; p = pLen(d, p).o; }
  const ct = d[p]; p++;
  const cl = pLen(d, p); p = cl.o;
  let cb: Uint8Array;
  if (ct === 0x04 && cl.l >= 0) {
    cb = d.slice(p, p + cl.l);
  } else {
    const ep = cl.l === -1 ? d.length : p + cl.l;
    const r = exOct(d, p, ep);
    let tl = 0;
    for (const c of r.c) tl += c.length;
    cb = new Uint8Array(tl);
    let off = 0;
    for (const c of r.c) { cb.set(c, off); off += c.length; }
  }
  const xml = new TextDecoder("utf-8").decode(cb).replace(/^[\ufeff\s]+/, "");
  if (!xml.includes("FatturaElettronica")) throw new Error("Contenuto P7M non è FatturaElettronica");
  return xml;
}

function byteScan(buf: ArrayBuffer): string {
  const d = new Uint8Array(buf);
  const dec = new TextDecoder("utf-8", { fatal: false });
  let s = -1;
  for (let i = 0; i < d.length - 5; i++)
    if (d[i] === 0x3c && d[i + 1] === 0x3f && d[i + 2] === 0x78 && d[i + 3] === 0x6d && d[i + 4] === 0x6c) { s = i; break; }
  if (s < 0) for (let i = 0; i < d.length - 1; i++)
    if (d[i] === 0x3c && ((d[i + 1] >= 0x41 && d[i + 1] <= 0x5a) || (d[i + 1] >= 0x61 && d[i + 1] <= 0x7a))) { s = i; break; }
  if (s < 0) throw new Error("No XML (byte-scan)");
  const raw = dec.decode(d.slice(s));
  const m = raw.match(/<\/[\w]*:?FatturaElettronica>/);
  if (!m) throw new Error("No closing tag (byte-scan)");
  return raw.substring(0, m.index! + m[0].length);
}

function stripNS(x: string): string {
  return x.replace(/<(\/?)[\w.-]+:/g, "<$1").replace(/\sxmlns[^=]*="[^"]*"/g, "").replace(/\s[\w.-]+:[\w.-]+="[^"]*"/g, "");
}

// ============================================================
// TYPES
// ============================================================
export interface InvoiceLine {
  numero: string
  codiceArticolo: string
  descrizione: string
  quantita: string
  unitaMisura: string
  prezzoUnitario: string
  prezzoTotale: string
  aliquotaIVA: string
  natura: string
}

export interface InvoicePayment {
  modalita: string
  scadenza: string
  importo: string
  iban: string
  istituto: string
}

export interface InvoiceBody {
  tipo: string
  divisa: string
  data: string
  numero: string
  totale: string
  arrotondamento: string
  causali: string[]
  bollo: { virtuale: string; importo: string }
  ritenuta: { tipo: string; importo: string; aliquota: string; causale: string }
  cassa: { tipo: string; al: string; importo: string; imponibile: string; alIVA: string }
  condPag: string
  pagamenti: InvoicePayment[]
  linee: InvoiceLine[]
  riepilogo: { aliquota: string; natura: string; imponibile: string; imposta: string; esigibilita: string; rifNorm: string }[]
  allegati: { nome: string; formato: string; descrizione: string; sizeKB: number; hasData: boolean; b64: string }[]
  contratti: { id: string; data: string; cig: string; cup: string }[]
  ordini: { id: string; data: string; cig: string; cup: string }[]
  ddt: { numero: string; data: string }[]
}

export interface ParsedInvoice {
  ver: string
  trasm: { idPaese: string; idCodice: string; progressivo: string; formato: string; codDest: string; pecDest: string }
  ced: { denom: string; piva: string; cf: string; regime: string; sede: string; tel: string; email: string; reaNumero: string; reaUfficio: string; capitale: string; liquidazione: string }
  ces: { denom: string; piva: string; cf: string; sede: string }
  bodies: InvoiceBody[]
}

export interface ParseResult {
  fn: string
  method: string
  xmlLen: number
  rawXml: string
  data: ParsedInvoice
  err: string | null
}

// ============================================================
// PARSER
// ============================================================
function parseFattura(xmlStr: string): ParsedInvoice {
  const doc = new DOMParser().parseFromString(stripNS(xmlStr), "text/xml");
  const pe = doc.querySelector("parsererror");
  if (pe) throw new Error("XML non valido: " + pe.textContent!.substring(0, 200));
  const root = doc.querySelector("FatturaElettronica");
  if (!root) throw new Error("FatturaElettronica non trovato");

  const g = (p: Element | null | undefined, s: string) => p?.querySelector(s)?.textContent?.trim() || "";
  const gA = (p: Element | null | undefined, s: string) => Array.from(p?.querySelectorAll(s) || []);

  const hdr = root.querySelector("FatturaElettronicaHeader");
  const tr = hdr?.querySelector("DatiTrasmissione");
  const ced = hdr?.querySelector("CedentePrestatore");
  const ces = hdr?.querySelector("CessionarioCommittente");

  const fAddr = (el: Element | null | undefined) => {
    if (!el) return "";
    return [
      [g(el, "Indirizzo"), g(el, "NumeroCivico")].filter(Boolean).join(" "),
      [g(el, "CAP"), g(el, "Comune"), g(el, "Provincia") ? `(${g(el, "Provincia")})` : ""].filter(Boolean).join(" "),
      g(el, "Nazione") !== "IT" ? g(el, "Nazione") : ""
    ].filter(Boolean).join(", ");
  };

  const bodies = gA(root, "FatturaElettronicaBody").map(body => {
    const dg = body.querySelector("DatiGenerali DatiGeneraliDocumento");
    const dgAll = body.querySelector("DatiGenerali");
    const bs = body.querySelector("DatiBeniServizi");
    const pg = body.querySelector("DatiPagamento");

    const contratti = gA(dgAll, "DatiContratto").map(c => ({
      id: g(c, "IdDocumento"), data: g(c, "Data"), cig: g(c, "CodiceCIG"), cup: g(c, "CodiceCUP"),
    }));

    const ordini = gA(dgAll, "DatiOrdineAcquisto").map(o => ({
      id: g(o, "IdDocumento"), data: g(o, "Data"), cig: g(o, "CodiceCIG"), cup: g(o, "CodiceCUP"),
    }));

    const ddt = gA(dgAll, "DatiDDT").map(d => ({
      numero: g(d, "NumeroDDT"), data: g(d, "DataDDT"),
    }));

    const linee = gA(bs, "DettaglioLinee").map(l => {
      const codici = gA(l, "CodiceArticolo").map(c => ({
        tipo: g(c, "CodiceTipo"), valore: g(c, "CodiceValore"),
      }));
      return {
        numero: g(l, "NumeroLinea"),
        codiceArticolo: codici.length > 0 ? codici.map(c => `${c.tipo}: ${c.valore}`).join(", ") : "",
        descrizione: g(l, "Descrizione"),
        quantita: g(l, "Quantita"),
        unitaMisura: g(l, "UnitaMisura"),
        prezzoUnitario: g(l, "PrezzoUnitario"),
        prezzoTotale: g(l, "PrezzoTotale"),
        aliquotaIVA: g(l, "AliquotaIVA"),
        natura: g(l, "Natura"),
      };
    });

    const riepilogo = gA(bs, "DatiRiepilogo").map(r => ({
      aliquota: g(r, "AliquotaIVA"), natura: g(r, "Natura"),
      imponibile: g(r, "ImponibileImporto"), imposta: g(r, "Imposta"),
      esigibilita: g(r, "EsigibilitaIVA"), rifNorm: g(r, "RiferimentoNormativo"),
    }));

    const pagamenti = gA(pg, "DettaglioPagamento").map(dp => ({
      modalita: g(dp, "ModalitaPagamento"),
      scadenza: g(dp, "DataScadenzaPagamento"),
      importo: g(dp, "ImportoPagamento"),
      iban: g(dp, "IBAN"),
      istituto: g(dp, "IstitutoFinanziario"),
    }));

    const allegati = gA(body, "Allegati").map(a => {
      const b64 = a.querySelector("Attachment")?.textContent?.trim() || "";
      return {
        nome: g(a, "NomeAttachment"),
        formato: g(a, "FormatoAttachment"),
        descrizione: g(a, "DescrizioneAttachment"),
        sizeKB: b64 ? Math.round(b64.length * 3 / 4 / 1024) : 0,
        hasData: b64.length > 0,
        b64,
      };
    });

    return {
      tipo: g(dg, "TipoDocumento"), divisa: g(dg, "Divisa"),
      data: g(dg, "Data"), numero: g(dg, "Numero"),
      totale: g(dg, "ImportoTotaleDocumento"),
      arrotondamento: g(dg, "Arrotondamento"),
      causali: gA(dg, "Causale").map(c => c.textContent?.trim() || ""),
      bollo: { virtuale: g(dg, "DatiBollo BolloVirtuale"), importo: g(dg, "DatiBollo ImportoBollo") },
      ritenuta: { tipo: g(dg, "DatiRitenuta TipoRitenuta"), importo: g(dg, "DatiRitenuta ImportoRitenuta"), aliquota: g(dg, "DatiRitenuta AliquotaRitenuta"), causale: g(dg, "DatiRitenuta CausalePagamento") },
      cassa: { tipo: g(dg, "DatiCassaPrevidenziale TipoCassa"), al: g(dg, "DatiCassaPrevidenziale AlCassa"), importo: g(dg, "DatiCassaPrevidenziale ImportoContributoCassa"), imponibile: g(dg, "DatiCassaPrevidenziale ImponibileCassa"), alIVA: g(dg, "DatiCassaPrevidenziale AliquotaIVA") },
      contratti, ordini, ddt, condPag: g(pg, "CondizioniPagamento"),
      pagamenti, linee, riepilogo, allegati,
    } as InvoiceBody;
  });

  return {
    ver: root.getAttribute("versione") || "",
    trasm: {
      idPaese: g(tr, "IdTrasmittente IdPaese"), idCodice: g(tr, "IdTrasmittente IdCodice"),
      progressivo: g(tr, "ProgressivoInvio"), formato: g(tr, "FormatoTrasmissione"),
      codDest: g(tr, "CodiceDestinatario"), pecDest: g(tr, "PECDestinatario"),
    },
    ced: {
      denom: g(ced, "DatiAnagrafici Anagrafica Denominazione") || [g(ced, "DatiAnagrafici Anagrafica Nome"), g(ced, "DatiAnagrafici Anagrafica Cognome")].filter(Boolean).join(" "),
      piva: [g(ced, "DatiAnagrafici IdFiscaleIVA IdPaese"), g(ced, "DatiAnagrafici IdFiscaleIVA IdCodice")].filter(Boolean).join(""),
      cf: g(ced, "DatiAnagrafici CodiceFiscale"),
      regime: g(ced, "DatiAnagrafici RegimeFiscale"),
      sede: fAddr(ced?.querySelector("Sede")),
      tel: g(ced, "Contatti Telefono"),
      email: g(ced, "Contatti Email"),
      reaUfficio: g(ced, "IscrizioneREA Ufficio"),
      reaNumero: g(ced, "IscrizioneREA NumeroREA"),
      capitale: g(ced, "IscrizioneREA CapitaleSociale"),
      liquidazione: g(ced, "IscrizioneREA StatoLiquidazione"),
    },
    ces: {
      denom: g(ces, "DatiAnagrafici Anagrafica Denominazione") || [g(ces, "DatiAnagrafici Anagrafica Nome"), g(ces, "DatiAnagrafici Anagrafica Cognome")].filter(Boolean).join(" "),
      piva: [g(ces, "DatiAnagrafici IdFiscaleIVA IdPaese"), g(ces, "DatiAnagrafici IdFiscaleIVA IdCodice")].filter(Boolean).join(""),
      cf: g(ces, "DatiAnagrafici CodiceFiscale"),
      sede: fAddr(ces?.querySelector("Sede")),
    },
    bodies,
  };
}

// ============================================================
// PUBLIC API
// ============================================================
function procBuf(buf: ArrayBuffer, fn: string): ParseResult {
  const ext = fn.toLowerCase();
  let xml: string, method: string;
  if (ext.endsWith(".p7m")) {
    try { xml = extractP7M(buf); method = "ASN.1 DER"; }
    catch (e1: any) {
      try { xml = byteScan(buf); method = "Byte-scan"; }
      catch (e2: any) { throw new Error(`DER: ${e1.message} | Scan: ${e2.message}`); }
    }
  } else {
    xml = new TextDecoder("utf-8").decode(new Uint8Array(buf));
    method = "XML";
  }
  if (!xml.includes("FatturaElettronica")) throw new Error("Non è una FatturaElettronica");
  return { fn, method, xmlLen: xml.length, rawXml: xml, data: parseFattura(xml), err: null };
}

export async function processInvoiceFile(file: File): Promise<ParseResult[]> {
  const name = file.name || "unknown";
  if (name.toLowerCase().endsWith(".zip")) {
    const JSZip = (await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm" as any)).default;
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const res: ParseResult[] = [];
    for (const [fn, entry] of Object.entries(zip.files) as any) {
      if (entry.dir) continue;
      const lf = fn.toLowerCase();
      if (!lf.endsWith(".xml") && !lf.endsWith(".p7m")) continue;
      try { res.push(procBuf(await entry.async("arraybuffer"), fn)); }
      catch (e: any) { res.push({ fn, method: "fallito", xmlLen: 0, rawXml: '', data: null as any, err: e.message }); }
    }
    return res;
  }
  try {
    return [procBuf(await file.arrayBuffer(), name)];
  } catch (e: any) {
    return [{ fn: name, method: "fallito", xmlLen: 0, rawXml: '', data: null as any, err: e.message }];
  }
}

// Lookup tables
export const TIPO: Record<string, string> = { TD01: "Fattura", TD02: "Acconto/Anticipo", TD03: "Acconto Parcella", TD04: "Nota di Credito", TD05: "Nota di Debito", TD06: "Parcella", TD07: "Fatt. semplificata", TD08: "NC semplificata", TD16: "Integr. RC interno", TD17: "Integr. servizi UE", TD18: "Integr. beni UE", TD19: "Integr. art.17", TD20: "Autofattura", TD24: "Fatt. differita", TD25: "Fatt. differita (b)", TD26: "Cess. ammortizzabili", TD27: "Autoconsumo", TD28: "Acq. San Marino" };
export const MP: Record<string, string> = { MP01: "Contanti", MP02: "Assegno", MP03: "Assegno circ.", MP05: "Bonifico", MP08: "Carta", MP09: "RID", MP12: "RIBA", MP13: "MAV", MP19: "SEPA DD", MP20: "SEPA CORE", MP22: "Trattenuta", MP23: "PagoPA" };
export const REG: Record<string, string> = { RF01: "Ordinario", RF02: "Minimi", RF04: "Agricoltura", RF18: "Altro", RF19: "Forfettario" };
