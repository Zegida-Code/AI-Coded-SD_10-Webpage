// Spot colour library files for RIP software, so the named colours of a test sheet (or of the final match) can be
// imported into the RIP. One exporter per format; more can be added as sample library files become available.
// colours: [{ name, lab: [L, a, b] }] – CIE L*a*b* D50 / 2°.

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

export const RIP_EXPORTS = {
  // CxF3 (ISO 17972-1, X-Rite Color Exchange Format) – the open standard for named colour libraries, imported by
  // many RIPs. Core schema only: one object per colour with its CIELab value, all sharing one D50/2° specification
  // (element names and enumerations as in the CxF3 schema overview's ColorChecker example).
  cxf: {
    label: 'CxF3',
    ext: 'cxf',
    mime: 'application/xml',
    build({ library, colours, created = new Date(), description = '' }) {
      const date = created.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const objects = colours.map(({ name, lab }, i) =>
        `<Object ObjectType="Standard" Name="${xmlEsc(name)}" Id="c${i + 1}">` +
        `<CreationDate>${date}</CreationDate>` +
        '<ColorValues><ColorCIELab ColorSpecification="CSD50-2">' +
        `<L>${lab[0].toFixed(2)}</L><A>${lab[1].toFixed(2)}</A><B>${lab[2].toFixed(2)}</B>` +
        '</ColorCIELab></ColorValues></Object>').join('\n      ');
      return `<?xml version="1.0" encoding="UTF-8"?>
<CxF xmlns="http://colorexchangeformat.com/CxF3-core" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://colorexchangeformat.com/CxF3-core CxF3_Core.xsd">
  <FileInformation>
    <Creator>SD-10 Web Console</Creator>
    <CreationDate>${date}</CreationDate>
    <Description>${xmlEsc([library, description].filter(Boolean).join(' – '))}</Description>
  </FileInformation>
  <Resources>
    <ObjectCollection>
      ${objects}
    </ObjectCollection>
    <ColorSpecificationCollection>
      <ColorSpecification Id="CSD50-2">
        <TristimulusSpec><Illuminant>D50</Illuminant><Observer>2_Degree</Observer><Method>E308_Table5</Method></TristimulusSpec>
        <MeasurementSpec>
          <MeasurementType>Colorimetric_Reflectance</MeasurementType>
          <GeometryChoice><SingleAngle><SingleAngleConfiguration>Annular</SingleAngleConfiguration><IlluminationAngle>45.0</IlluminationAngle><MeasurementAngle>0.0</MeasurementAngle></SingleAngle></GeometryChoice>
        </MeasurementSpec>
      </ColorSpecification>
    </ColorSpecificationCollection>
  </Resources>
</CxF>
`;
    },
  },

  // Roland VersaWorks 6 – format copied from a library exported by VersaWorks (strVersion 4.3.0.0).
  versaworks: {
    label: 'VersaWorks .spot',
    ext: 'spot',
    mime: 'application/xml',
    build({ library, colours }) {
      const items = colours.map(({ name, lab }) =>
        `<Lab16SpotColor name="${xmlEsc(name)}" flags="0" redirectLibraryName="" redirectColorName="">` +
        `<L VALUE="${lab[0].toFixed(2)}"/><a VALUE="${lab[1].toFixed(2)}"/><b VALUE="${lab[2].toFixed(2)}"/></Lab16SpotColor>`).join('');
      return '<?xml version="1.0" encoding="UTF-8"?>\n<SpotColorLibraryList strVersion="4.3.0.0">' +
        `<LabSpotColorLibrary name="${xmlEsc(library)}"><m_eMakerType>0</m_eMakerType><m_bUseLibrary>false</m_bUseLibrary>` +
        `${items}</LabSpotColorLibrary></SpotColorLibraryList>\n`;
    },
  },
};
