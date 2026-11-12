import PDFDocument from 'pdfkit';
import { billingTotals } from './billing.js';
import { Readable } from 'node:stream';

/**
 * PDF Invoice Generator for YYC Brokers
 * Generates professional invoices for completed deliveries
 */

/**
 * Generate invoice PDF as a buffer
 * @param {Object} shipment - Shipment data
 * @param {Object} store - Store owner data
 * @param {Object} driver - Driver data
 * @returns {Promise<Buffer>}
 */
export async function generateInvoice(shipment, store, driver) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // Header
    doc.fontSize(24).fillColor('#1c3554').text('YYC BROKERS', { align: 'center' });
    doc.fontSize(10).fillColor('#666').text('Trucking & Delivery Platform', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).text('Calgary, Alberta', { align: 'center' });
    doc.moveDown(2);

    // Invoice title
    doc.fontSize(18).fillColor('#000').text('DELIVERY INVOICE', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor('#666').text(`Invoice #${shipment.id}`, { align: 'center' });
    doc.moveDown(2);

    // Invoice details box
    const startY = doc.y;
    doc.fontSize(10).fillColor('#000');

    // Left column - Customer info
    doc.text('BILL TO:', 50, startY);
    doc.fontSize(11).text(store.name, 50, startY + 20);
    doc.fontSize(9).fillColor('#666');
    if (store.profile.address) {
      doc.text(store.profile.address, 50, startY + 40);
    }
    doc.text(store.email, 50, startY + 55);
    if (store.profile.phone) {
      doc.text(store.profile.phone, 50, startY + 70);
    }

    // Right column - Invoice info
    doc.fillColor('#000').fontSize(10);
    doc.text('Invoice Date:', 350, startY);
    doc.text('Shipment ID:', 350, startY + 15);
    doc.text('Status:', 350, startY + 30);
    doc.text('Payment Status:', 350, startY + 45);

    doc.fillColor('#666');
    doc.text(new Date().toLocaleDateString(), 450, startY);
    doc.text(shipment.id, 450, startY + 15);
    doc.text(shipment.status.toUpperCase(), 450, startY + 30);
    doc.text((shipment.payment_status || 'pending').toUpperCase(), 450, startY + 45);

    doc.moveDown(6);

    // Shipment details section
    doc.fillColor('#1c3554').fontSize(12).text('SHIPMENT DETAILS', { underline: true });
    doc.moveDown(0.5);

    doc.fillColor('#000').fontSize(10);
    doc.text(`Pickup: ${shipment.data.pickup}`, { width: 500 });
    doc.moveDown(0.3);
    doc.text(`Delivery: ${shipment.data.delivery}`, { width: 500 });
    doc.moveDown(0.3);

    if (shipment.data.items) {
      doc.text(`Items: ${shipment.data.items}`, { width: 500 });
      doc.moveDown(0.3);
    }

    if (shipment.data.weight) {
      doc.text(`Weight: ${shipment.data.weight} kg`);
      doc.moveDown(0.3);
    }

    if (driver) {
      doc.text(`Driver: ${driver.name}`);
      doc.moveDown(0.3);
    }

    doc.moveDown(2);

    // Line items table
    const tableTop = doc.y;
    const itemCodeX = 50;
    const descriptionX = 150;
    const quantityX = 350;
    const priceX = 420;
    const amountX = 490;

    // Table header
    doc.fillColor('#1c3554').fontSize(10);
    doc.rect(50, tableTop, 495, 25).fillAndStroke('#f0f0f0', '#ccc');
    doc.fillColor('#000').text('ITEM', itemCodeX + 5, tableTop + 8);
    doc.text('DESCRIPTION', descriptionX + 5, tableTop + 8);
    doc.text('QTY', quantityX + 5, tableTop + 8);
    doc.text('RATE', priceX + 5, tableTop + 8);
    doc.text('AMOUNT', amountX + 5, tableTop + 8);

    // Line item
    let currentY = tableTop + 35;
    doc.fontSize(9).fillColor('#333');
    doc.text('1', itemCodeX + 5, currentY);
    doc.text('Delivery Service', descriptionX + 5, currentY, { width: 180 });
    doc.text('1', quantityX + 5, currentY);
    doc.text(`$${shipment.data.price.toFixed(2)}`, priceX + 5, currentY);
    doc.text(`$${shipment.data.price.toFixed(2)}`, amountX + 5, currentY);

    // Horizontal line
    currentY += 25;
    doc.moveTo(50, currentY).lineTo(545, currentY).stroke('#ccc');

    // Subtotal, taxes, total
    currentY += 15;
    const totalsX = 420;

    const totals = billingTotals(shipment.data);
    doc.fontSize(10).fillColor('#333');
    if (totals.credits > 0) {
      doc.text('Claim credits:', totalsX, currentY);
      doc.text(`-$${totals.credits.toFixed(2)}`, amountX + 5, currentY);
      currentY += 20;
    }
    doc.text('Subtotal:', totalsX, currentY);
    doc.text(`$${totals.subtotal.toFixed(2)}`, amountX + 5, currentY);

    currentY += 20;
    doc.text('GST (5%):', totalsX, currentY);
    doc.text(`$${totals.tax.toFixed(2)}`, amountX + 5, currentY);

    currentY += 25;
    const total = totals.total;
    doc.fontSize(12).fillColor('#1c3554');
    doc.rect(totalsX - 10, currentY - 5, 135, 25).fillAndStroke('#f0f0f0', '#1c3554');
    doc.fillColor('#000').text('TOTAL:', totalsX, currentY);
    doc.fontSize(14).text(`$${total.toFixed(2)} CAD`, amountX + 5, currentY);

    // Footer
    doc.fontSize(8).fillColor('#999');
    doc.text(
      'Thank you for using YYC Brokers! For questions about this invoice, please contact us.',
      50,
      750,
      { align: 'center', width: 500 }
    );

    doc.end();
  });
}

/**
 * Generate invoice and return as readable stream
 * @param {Object} shipment - Shipment data
 * @param {Object} store - Store owner data
 * @param {Object} driver - Driver data
 * @returns {PDFDocument}
 */
export function generateInvoiceStream(shipment, store, driver) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  // Same generation logic as above
  // (Stream version for direct HTTP response piping)

  // Header
  doc.fontSize(24).fillColor('#1c3554').text('YYC BROKERS', { align: 'center' });
  doc.fontSize(10).fillColor('#666').text('Trucking & Delivery Platform', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).text('Calgary, Alberta', { align: 'center' });
  doc.moveDown(2);

  // Invoice title
  doc.fontSize(18).fillColor('#000').text('DELIVERY INVOICE', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(12).fillColor('#666').text(`Invoice #${shipment.id}`, { align: 'center' });
  doc.moveDown(2);

  // Invoice details
  const startY = doc.y;
  doc.fontSize(10).fillColor('#000');
  doc.text('BILL TO:', 50, startY);
  doc.fontSize(11).text(store.name, 50, startY + 20);
  doc.fontSize(9).fillColor('#666');
  if (store.profile.address) {
    doc.text(store.profile.address, 50, startY + 40);
  }
  doc.text(store.email, 50, startY + 55);

  doc.fillColor('#000').fontSize(10);
  doc.text('Invoice Date:', 350, startY);
  doc.text('Shipment ID:', 350, startY + 15);
  doc.fillColor('#666');
  doc.text(new Date().toLocaleDateString(), 450, startY);
  doc.text(shipment.id, 450, startY + 15);

  doc.moveDown(6);

  // Shipment details
  doc.fillColor('#1c3554').fontSize(12).text('SHIPMENT DETAILS', { underline: true });
  doc.moveDown(0.5);
  doc.fillColor('#000').fontSize(10);
  doc.text(`Pickup: ${shipment.data.pickup}`, { width: 500 });
  doc.moveDown(0.3);
  doc.text(`Delivery: ${shipment.data.delivery}`, { width: 500 });
  doc.moveDown(2);

  // Total
  doc.fontSize(12).fillColor('#1c3554').text(`TOTAL: $${billingTotals(shipment.data).total.toFixed(2)} CAD (incl. GST)`, {
    align: 'right'
  });

  doc.end();

  return doc;
}
