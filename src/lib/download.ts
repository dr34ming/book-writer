import jsPDF from 'jspdf';

export interface DownloadChapter {
	position: number;
	title: string;
	outline: string | null;
	paragraphs: { position: number; content: string }[];
}

function slugify(text: string): string {
	return text.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '-').toLowerCase();
}

function timestamp(): string {
	const d = new Date();
	return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildMarkdown(title: string, chapters: DownloadChapter[]): string {
	let md = `# ${title}\n\n`;
	for (const ch of chapters) {
		md += `## ${ch.position}. ${ch.title}\n\n`;
		if (ch.outline) md += `> ${ch.outline}\n\n`;
		for (const p of ch.paragraphs) {
			md += `${p.content}\n\n`;
		}
	}
	return md;
}

function buildPdf(title: string, chapters: DownloadChapter[]): jsPDF {
	const doc = new jsPDF({ unit: 'mm', format: 'letter' });
	const pageWidth = doc.internal.pageSize.getWidth();
	const margin = 25;
	const textWidth = pageWidth - margin * 2;
	let y = 40;

	const checkPage = (needed: number) => {
		if (y + needed > doc.internal.pageSize.getHeight() - margin) {
			doc.addPage();
			y = margin;
		}
	};

	// Title page
	doc.setFontSize(24);
	doc.text(title, pageWidth / 2, 80, { align: 'center' });
	doc.addPage();
	y = margin;

	for (const ch of chapters) {
		checkPage(20);
		doc.setFontSize(16);
		doc.setFont('helvetica', 'bold');
		doc.text(`${ch.position}. ${ch.title}`, margin, y);
		y += 10;

		if (ch.outline) {
			checkPage(10);
			doc.setFontSize(10);
			doc.setFont('helvetica', 'italic');
			const outlineLines = doc.splitTextToSize(ch.outline, textWidth - 10);
			doc.text(outlineLines, margin + 5, y);
			y += outlineLines.length * 4.5 + 6;
		}

		doc.setFontSize(11);
		doc.setFont('helvetica', 'normal');
		for (const p of ch.paragraphs) {
			const lines = doc.splitTextToSize(p.content, textWidth);
			checkPage(lines.length * 5 + 4);
			doc.text(lines, margin, y);
			y += lines.length * 5 + 4;
		}

		y += 8;
	}

	return doc;
}

function triggerDownload(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

export function downloadMarkdown(title: string, chapters: DownloadChapter[]) {
	const md = buildMarkdown(title, chapters);
	triggerDownload(new Blob([md], { type: 'text/markdown' }), `${slugify(title)}-${timestamp()}.md`);
}

export function downloadPdf(title: string, chapters: DownloadChapter[]) {
	const doc = buildPdf(title, chapters);
	const blob = doc.output('blob');
	triggerDownload(blob, `${slugify(title)}-${timestamp()}.pdf`);
}
