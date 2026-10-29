import type { GalleryCategory } from '@nexus/shared';

export interface GalleryEntry {
  id: string;
  category: GalleryCategory;
  title: string;
  /** Commons file title; license and author are read from Commons when the picture is downloaded. */
  file: string;
  focal?: [number, number];
}

/**
 * 精选图库. Every file was checked on Wikimedia Commons (landscape, ≥ 3000 px, CC0 / public domain /
 * CC BY / CC BY-SA); the server still re-checks the license before each download.
 */
export const GALLERY: readonly GalleryEntry[] = [
  { id: 'fuji-sunset', category: 'nature', title: '富士山暮色', file: 'File:Mount Fuji at sunset, March 2025.jpg', focal: [52, 55] }, // CC0 · 11650×7767
  { id: 'lake-louise', category: 'nature', title: '加拿大路易斯湖', file: 'File:1 lake louise pano 2019.jpg', focal: [55, 55] }, // CC BY-SA 4.0 · 14102×7912
  { id: 'glen-coe', category: 'nature', title: '苏格兰格伦科峡谷', file: 'File:Lagangarbh cottage with Buachaille Etive Mòr.jpg', focal: [40, 45] }, // CC BY-SA 4.0 · 9429×5304
  { id: 'twelve-apostles', category: 'nature', title: '澳洲十二门徒岩', file: 'File:Princetown (AU), Port Campbell National Park, Twelve Apostles -- 2019 -- 0930.jpg', focal: [38, 45] }, // CC BY-SA 4.0 · 6687×4458
  { id: 'valencia-hemisferic', category: 'architecture', title: '瓦伦西亚艺术科学城', file: 'File:Hemispheric Twilight - Valencia, Spain - Jan 2007.jpg', focal: [45, 50] }, // CC BY-SA 3.0 · 10598×5656
  { id: 'donggung-palace', category: 'architecture', title: '庆州东宫月池', file: 'File:Water reflection of Donggung Palace in Wolji Pond at blue hour in Gyeongju South Korea.jpg', focal: [50, 40] }, // CC BY-SA 4.0 · 6497×4331
  { id: 'niteroi-mac', category: 'architecture', title: '尼泰罗伊当代艺术馆', file: 'File:Vista Geral do Museu de Arte Contemporânea de Niterói... MAC.jpg', focal: [28, 32] }, // CC BY-SA 4.0 · 5800×3751
  { id: 'toronto-facade', category: 'architecture', title: '多伦多玻璃幕墙', file: 'File:Fragment of 160 Front Street West, Toronto.jpg', focal: [60, 40] }, // CC BY-SA 4.0 · 9504×6336
  { id: 'deadvlei-tree', category: 'minimal', title: '纳米布沙漠枯树', file: 'File:Dead Vlei, Sossusvlei, Namibia, 2018-08-06, DD 086.jpg', focal: [50, 55] }, // CC BY-SA 4.0 · 8078×5399
  { id: 'uyuni-reflection', category: 'minimal', title: '乌尤尼盐沼倒影', file: 'File:Salar de Uyuni, Bolivia, 2016-02-04, DD 10-12 HDR.JPG', focal: [50, 48] }, // CC BY-SA 4.0 · 8654×4868
  { id: 'hoverla-fog', category: 'minimal', title: '霍韦尔拉山云海', file: 'File:Гора Говерла після заходу сонця.jpg', focal: [43, 67] }, // CC BY-SA 4.0 · 5519×3679
  { id: 'sand-ripples', category: 'minimal', title: '加那利沙滩纹理', file: 'File:Morro Jable (Fuerteventura, Spain), Strand -- 2025 -- 2487.jpg', focal: [66, 50] }, // CC BY-SA 4.0 · 5472×3648
  { id: 'shanghai-pudong', category: 'city', title: '上海浦东夜景', file: 'File:Pudong Shanghai November 2017 HDR panorama.jpg', focal: [45, 60] }, // CC BY-SA 4.0 · 10200×5100
  { id: 'manhattan-dusk', category: 'city', title: '纽约曼哈顿黄昏', file: 'File:Lower Manhattan from Jersey City November 2016 002.jpg', focal: [40, 45] }, // CC BY-SA 4.0 · 5920×3330
  { id: 'singapore-cbd', category: 'city', title: '新加坡金融区傍晚', file: 'File:Skyline of the Central Business District of Singapore with Esplanade Bridge in the evening.jpg', focal: [55, 42] }, // CC BY-SA 4.0 · 6661×3747
  { id: 'frankfurt-night', category: 'city', title: '法兰克福夜色', file: 'File:Frankfurt Skyline 2022 bei Nacht.jpg', focal: [58, 45] }, // CC BY-SA 4.0 · 6221×4000
  { id: 'myvatn-aurora', category: 'dark', title: '冰岛米湖极光', file: 'File:039 Northern lights over Mývatn (Iceland) Photo by Giles Laurent.jpg', focal: [60, 35] }, // CC BY-SA 4.0 · 6837×4560
  { id: 'pedra-azul-milky-way', category: 'dark', title: '巴西蓝石山银河', file: 'File:Pedra Azul Milky Way.jpg', focal: [38, 55] }, // CC BY-SA 4.0 · 5657×3769
  { id: 'everest-dusk', category: 'dark', title: '珠穆朗玛峰暮色', file: 'File:Sunset view of Everest.jpg', focal: [52, 58] }, // CC BY-SA 4.0 · 6000×4000
  { id: 'isaac-lake-storm', category: 'dark', title: '风暴前的艾萨克湖', file: 'File:Isaac Lake during golden hour, moments before a storm (DSCF2631).jpg', focal: [50, 45] }, // CC BY 4.0 · 4759×3175
];
