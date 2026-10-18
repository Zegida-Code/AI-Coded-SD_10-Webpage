// Spot colour library files for RIP software, so the named colours of a test sheet (or of the final match) can be
// imported into the RIP. One exporter per RIP; more can be added as sample library files become available.
// colours: [{ name, lab: [L, a, b] }] – CIE L*a*b* D50 / 2°.

const xmlAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

export const RIP_EXPORTS = {
  // Roland VersaWorks 6 – format copied from a library exported by VersaWorks (strVersion 4.3.0.0).
  versaworks: {
    label: 'VersaWorks 6',
    ext: 'spot',
    mime: 'application/xml',
    build({ library, colours }) {
      const items = colours.map(({ name, lab }) =>
        `<Lab16SpotColor name="${xmlAttr(name)}" flags="0" redirectLibraryName="" redirectColorName="">` +
        `<L VALUE="${lab[0].toFixed(2)}"/><a VALUE="${lab[1].toFixed(2)}"/><b VALUE="${lab[2].toFixed(2)}"/></Lab16SpotColor>`).join('');
      return '<?xml version="1.0" encoding="UTF-8"?>\n<SpotColorLibraryList strVersion="4.3.0.0">' +
        `<LabSpotColorLibrary name="${xmlAttr(library)}"><m_eMakerType>0</m_eMakerType><m_bUseLibrary>false</m_bUseLibrary>` +
        `${items}</LabSpotColorLibrary></SpotColorLibraryList>\n`;
    },
  },
};
