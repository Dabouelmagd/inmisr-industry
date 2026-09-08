// ─── rfq-templates/rfq-templates.ts ──────────────────────────────
// قوالب RFQ الكاملة لكل الـ 28 قطاع الصناعي
// تُستخدم في seed.ts وفي واجهة إنشاء الطلبات

export interface RfqField {
  key:        string;
  labelAr:    string;
  type:       'text' | 'number' | 'select' | 'multiselect' | 'boolean';
  required:   boolean;
  options?:   string[];
  unit?:      string;
  placeholder?: string;
}

export interface SectorTemplate {
  sectorCode:  string;
  nameAr:      string;
  nameEn:      string;
  icon:        string;
  generalFields: RfqField[];   // مشتركة مع كل القطاعات
  specificFields: RfqField[];  // خاصة بهذا القطاع
}

// ── GENERAL FIELDS (apply to all 28 sectors) ─────────────────────
const GENERAL_FIELDS: RfqField[] = [
  { key: 'quantity',        labelAr: 'الكمية المطلوبة',          type: 'number',  required: true,  placeholder: 'مثال: ٥٠' },
  { key: 'unit',            labelAr: 'وحدة القياس',              type: 'select',  required: true,  options: ['طن', 'كجم', 'لتر', 'متر', 'وحدة', 'لوح', 'بكرة'] },
  { key: 'grade',           labelAr: 'المواصفة / الدرجة',         type: 'text',    required: true,  placeholder: 'ISO/ASTM/EN...' },
  { key: 'tolerance',       labelAr: 'نطاق التفاوض المقبول',       type: 'text',    required: false, placeholder: 'مثال: ±٢٪' },
  { key: 'deadline',        labelAr: 'تاريخ التسليم المطلوب',      type: 'text',    required: true },
  { key: 'delivery_city',   labelAr: 'مدينة التسليم',             type: 'text',    required: true },
  { key: 'delivery_zone',   labelAr: 'المنطقة الصناعية',           type: 'select',  required: false, options: ['العاشر من رمضان', '٦ أكتوبر', 'العبور', 'السادات', 'برج العرب', 'إمبابة', 'بدر', 'الشروق'] },
  { key: 'payment_method',  labelAr: 'طريقة الدفع المفضلة',        type: 'select',  required: true,  options: ['Escrow (موصى به)', 'تقسيط بنكي', 'دفعات: مقدم + تسليم', 'آجل ٣٠ يوم'] },
  { key: 'quality_cert',    labelAr: 'شهادات الجودة المطلوبة',     type: 'multiselect', required: false, options: ['ISO 9001', 'SGS', 'Bureau Veritas', 'شهادة مصنع', 'MSDS', 'COA'] },
  { key: 'acceptance_policy', labelAr: 'سياسة القبول والرفض',    type: 'text',    required: true,  placeholder: 'شروط قبول أو رفض الشحنة' },
  { key: 'notes',           labelAr: 'ملاحظات إضافية',            type: 'text',    required: false },
];

// ── ALL 28 SECTOR TEMPLATES ───────────────────────────────────────
export const SECTOR_TEMPLATES: SectorTemplate[] = [
  {
    sectorCode: 'iron_steel', nameAr: 'الحديد ومشتقاته', nameEn: 'Iron & Steel', icon: '🔩',
    generalFields: GENERAL_FIELDS,
    specificFields: [
      { key: 'alloy_grade',    labelAr: 'درجة السبيكة',    type: 'select', required: true,  options: ['AISI 1020', 'AISI 1045', 'SS304', 'SS316', 'A36', 'ST37'] },
      { key: 'thickness_mm',   labelAr: 'السُّمك (mm)',     type: 'number', required: true,  unit: 'mm' },
      { key: 'finish',         labelAr: 'التشطيب',         type: 'select', required: true,  options: ['Hot Rolled', 'Cold Rolled', 'Galvanized', 'Painted', 'Pickled'] },
      { key: 'carbon_pct',     labelAr: 'نسبة الكربون ٪',  type: 'number', required: false, unit: '%' },
      { key: 'manganese_pct',  labelAr: 'نسبة المنجنيز ٪', type: 'number', required: false, unit: '%' },
      { key: 'form',           labelAr: 'شكل المنتج',      type: 'select', required: true,  options: ['تسليح', 'صاج', 'أنابيب', 'زاوية', 'IPE', 'HEA', 'أسلاك', 'Seamless'] },
      { key: 'standard',       labelAr: 'المعيار الدولي',  type: 'select', required: false, options: ['ASTM', 'EN', 'DIN', 'JIS', 'BS', 'ISO'] },
    ],
  },
  {
    sectorCode: 'petrochemicals', nameAr: 'البتروكيماويات', nameEn: 'Petrochemicals', icon: '⚗️',
    generalFields: GENERAL_FIELDS,
    specificFields: [
      { key: 'polymer_type',   labelAr: 'نوع البوليمر',     type: 'select',  required: true,  options: ['PP', 'PE-LD', 'PE-HD', 'PVC', 'PET', 'PS', 'ABS', 'POM'] },
      { key: 'grade',          labelAr: 'الدرجة',           type: 'select',  required: true,  options: ['درجة غذائية', 'درجة طبية', 'درجة صناعية', 'درجة تغليف'] },
      { key: 'mfi',            labelAr: 'مؤشر التدفق (MFI)', type: 'number', required: true,  unit: 'g/10min' },
      { key: 'form',           labelAr: 'شكل التوريد',      type: 'select',  required: true,  options: ['حبيبات', 'مسحوق', 'خيوط'] },
      { key: 'color',          labelAr: 'اللون',            type: 'select',  required: false, options: ['طبيعي', 'أبيض', 'أسود', 'حسب الطلب'] },
      { key: 'ash_content',    labelAr: 'محتوى الرماد ٪',   type: 'number',  required: false, unit: '%' },
    ],
  },
  {
    sectorCode: 'solar', nameAr: 'مكونات الطاقة الشمسية', nameEn: 'Solar Energy', icon: '☀️',
    generalFields: GENERAL_FIELDS,
    specificFields: [
      { key: 'component_type', labelAr: 'نوع المكون',     type: 'select', required: true,  options: ['ألواح PV', 'عاكس Inverter', 'بطاريات', 'وحدات تتبع', 'كابلات DC', 'هيكل تركيب'] },
      { key: 'power_wp',       labelAr: 'القدرة (Wp)',     type: 'number', required: true,  unit: 'Wp' },
      { key: 'efficiency_pct', labelAr: 'كفاءة التحويل ٪', type: 'number', required: true,  unit: '%' },
      { key: 'iec_standard',   labelAr: 'معيار الاعتماد',  type: 'select', required: true,  options: ['IEC 61215', 'IEC 61730', 'UL 1703', 'MCS'] },
      { key: 'warranty_years', labelAr: 'ضمان الأداء (سنوات)', type: 'number', required: true, unit: 'سنة' },
      { key: 'cell_type',      labelAr: 'نوع الخلية',      type: 'select', required: false, options: ['Monocrystalline', 'Polycrystalline', 'Thin Film', 'Bifacial'] },
    ],
  },
  {
    sectorCode: 'food', nameAr: 'الصناعات الغذائية', nameEn: 'Food Industries', icon: '🌾',
    generalFields: GENERAL_FIELDS,
    specificFields: [
      { key: 'product_type',   labelAr: 'نوع المنتج',        type: 'text',      required: true },
      { key: 'ingredients',    labelAr: 'المكونات الرئيسية',  type: 'text',      required: true },
      { key: 'halal',          labelAr: 'شهادة حلال',        type: 'boolean',   required: true },
      { key: 'organic',        labelAr: 'عضوي',              type: 'boolean',   required: false },
      { key: 'shelf_life_months', labelAr: 'مدة الصلاحية',   type: 'number',    required: true, unit: 'شهر' },
      { key: 'storage_temp',   labelAr: 'درجة حرارة التخزين', type: 'select',   required: true, options: ['درجة حرارة الغرفة', 'مبرد (٢-٨°م)', 'مجمد (-١٨°م)'] },
      { key: 'packaging',      labelAr: 'نوع التعبئة',        type: 'select',   required: true, options: ['أكياس', 'علب معدنية', 'زجاجات', 'BigBag', 'Drums'] },
    ],
  },
  {
    sectorCode: 'textile', nameAr: 'الصناعات النسيجية', nameEn: 'Textile', icon: '🧵',
    generalFields: GENERAL_FIELDS,
    specificFields: [
      { key: 'gsm',            labelAr: 'الوزن (GSM)',         type: 'number', required: true,  unit: 'g/m²' },
      { key: 'denier',         labelAr: 'كثافة الخيط (Denier)', type: 'number', required: false, unit: 'D' },
      { key: 'composition',    labelAr: 'التركيب النسيجي',     type: 'text',   required: true,  placeholder: 'مثال: ١٠٠٪ كوتون، ٦٠٪ بوليستر ٤٠٪ قطن' },
      { key: 'finish',         labelAr: 'التشطيب',             type: 'multiselect', required: false, options: ['Anti-wrinkle', 'Mercerized', 'Sanforized', 'Fire retardant', 'Water repellent'] },
      { key: 'colorfast_grade', labelAr: 'درجة ثبات اللون',    type: 'select', required: false, options: ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5'] },
      { key: 'width_cm',       labelAr: 'عرض القماش (cm)',     type: 'number', required: false, unit: 'cm' },
    ],
  },
  {
    sectorCode: 'aluminum', nameAr: 'الألومنيوم', nameEn: 'Aluminium', icon: '🔩',
    generalFields: GENERAL_FIELDS,
    specificFields: [
      { key: 'alloy',          labelAr: 'السبيكة',            type: 'select', required: true,  options: ['1100', '3003', '5052', '6061', '6063', '7075'] },
      { key: 'temper',         labelAr: 'الحالة الميكانيكية', type: 'select', required: true,  options: ['O (Annealed)', 'H14', 'H24', 'T4', 'T6', 'T651'] },
      { key: 'form',           labelAr: 'شكل المنتج',         type: 'select', required: true,  options: ['ألواح', 'لفائف', 'قطاعات بثق', 'أسلاك', 'فويل'] },
      { key: 'thickness_mm',   labelAr: 'السُّمك (mm)',        type: 'number', required: true,  unit: 'mm' },
      { key: 'finish',         labelAr: 'التشطيب',            type: 'select', required: false, options: ['Mill Finish', 'Anodized', 'Powder Coated', 'Painted'] },
    ],
  },
  {
    sectorCode: 'pharma', nameAr: 'مستحضرات طبية وتجميل', nameEn: 'Pharma & Cosmetics', icon: '💊',
    generalFields: GENERAL_FIELDS,
    specificFields: [
      { key: 'active_ingredient', labelAr: 'المادة الفعالة',    type: 'text',   required: true },
      { key: 'concentration',     labelAr: 'التركيز',           type: 'text',   required: true, placeholder: 'مثال: ٩٩.٥٪' },
      { key: 'pharmacopeia',      labelAr: 'دستور الأدوية',     type: 'select', required: true, options: ['BP', 'USP', 'EP', 'JP', 'IP'] },
      { key: 'cas_number',        labelAr: 'رقم CAS',           type: 'text',   required: false },
      { key: 'batch_size',        labelAr: 'حجم الدفعة',        type: 'number', required: false },
      { key: 'coa_required',      labelAr: 'شهادة تحليل COA',   type: 'boolean', required: true },
      { key: 'msds_required',     labelAr: 'بطاقة السلامة MSDS', type: 'boolean', required: true },
    ],
  },
  {
    sectorCode: 'pumps_motors', nameAr: 'مضخات ومواتير', nameEn: 'Pumps & Motors', icon: '⚙️',
    generalFields: GENERAL_FIELDS,
    specificFields: [
      { key: 'type',           labelAr: 'النوع',                type: 'select', required: true,  options: ['مضخة طاردة مركزية', 'مضخة غاطسة', 'مضخة تروس', 'موتور ثلاثي الأوجه', 'موتور أحادي'] },
      { key: 'power_kw',       labelAr: 'القدرة (kW)',          type: 'number', required: true,  unit: 'kW' },
      { key: 'flow_rate',      labelAr: 'معدل التدفق (m³/h)',   type: 'number', required: true,  unit: 'm³/h' },
      { key: 'head_m',         labelAr: 'الضغط (m Head)',       type: 'number', required: false, unit: 'm' },
      { key: 'voltage',        labelAr: 'الجهد الكهربائي (V)',  type: 'select', required: true,  options: ['220V/1Ph', '380V/3Ph', '415V/3Ph', '6.6kV'] },
      { key: 'fluid_type',     labelAr: 'نوع السائل',           type: 'select', required: false, options: ['ماء نظيف', 'مياه صرف', 'مواد كيميائية', 'نفط', 'وقود'] },
      { key: 'efficiency_class', labelAr: 'فئة الكفاءة',        type: 'select', required: false, options: ['IE1', 'IE2', 'IE3', 'IE4'] },
    ],
  },
  {
    sectorCode: 'transformers', nameAr: 'المحولات الكهربائية', nameEn: 'Transformers', icon: '⚡',
    generalFields: GENERAL_FIELDS,
    specificFields: [
      { key: 'kva',            labelAr: 'القدرة (KVA)',         type: 'number', required: true,  unit: 'KVA' },
      { key: 'voltage_primary', labelAr: 'الجهد الابتدائي',    type: 'text',   required: true,  placeholder: 'مثال: ١١ kV' },
      { key: 'voltage_secondary', labelAr: 'الجهد الثانوي',   type: 'text',   required: true,  placeholder: 'مثال: ٠.٤ kV' },
      { key: 'cooling_type',   labelAr: 'نوع التبريد',         type: 'select', required: true,  options: ['ONAN (زيت طبيعي)', 'ONAF (زيت + هواء)', 'جاف', 'كاست رازن'] },
      { key: 'frequency',      labelAr: 'التردد (Hz)',          type: 'select', required: true,  options: ['50 Hz', '60 Hz'] },
      { key: 'vector_group',   labelAr: 'مجموعة الناقل',       type: 'text',   required: false, placeholder: 'مثال: Dyn11' },
      { key: 'iec_standard',   labelAr: 'معيار IEC',           type: 'select', required: false, options: ['IEC 60076', 'IEC 60296', 'ANSI C57'] },
    ],
  },
  {
    sectorCode: 'generators', nameAr: 'المولدات الكهربائية', nameEn: 'Generators', icon: '🔌',
    generalFields: GENERAL_FIELDS,
    specificFields: [
      { key: 'kva',            labelAr: 'القدرة (KVA)',         type: 'number', required: true, unit: 'KVA' },
      { key: 'fuel_type',      labelAr: 'نوع الوقود',          type: 'select', required: true, options: ['ديزل', 'بنزين', 'غاز طبيعي', 'بروبان', 'هجين'] },
      { key: 'phase',          labelAr: 'الأوجه',              type: 'select', required: true, options: ['أحادي الوجه', 'ثلاثي الأوجه'] },
      { key: 'avr_type',       labelAr: 'نوع منظم الجهد',      type: 'select', required: false, options: ['AVR إلكتروني', 'PMG', 'AREP'] },
      { key: 'engine_brand',   labelAr: 'ماركة المحرك',        type: 'select', required: false, options: ['Cummins', 'Perkins', 'Volvo', 'Doosan', 'Mitsubishi', 'Baudouin'] },
      { key: 'noise_level_db', labelAr: 'مستوى الضوضاء (dB)',  type: 'number', required: false, unit: 'dB' },
      { key: 'enclosure',      labelAr: 'نوع الحاوية',         type: 'select', required: false, options: ['مفتوح', 'صامت (Silent)', 'كانوبي', 'حاوية'] },
    ],
  },
  // ── Additional 18 sectors with core fields ────────────────────
  { sectorCode: 'automotive',    nameAr: 'سيارات ومكوناتها',        nameEn: 'Automotive',        icon: '🚗', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'oem_number', labelAr: 'رقم OEM', type: 'text', required: true }, { key: 'vehicle_make', labelAr: 'ماركة السيارة', type: 'text', required: true }, { key: 'material', labelAr: 'المادة', type: 'text', required: false }] },
  { sectorCode: 'scada',         nameAr: 'برمجيات التحكم الصناعي', nameEn: 'Industrial SCADA',  icon: '🖥️', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'protocol', labelAr: 'البروتوكول', type: 'select', required: true, options: ['Modbus RTU', 'Modbus TCP', 'Profibus', 'Profinet', 'OPC-UA'] }, { key: 'sla_hours', labelAr: 'SLA (ساعة)', type: 'number', required: true }] },
  { sectorCode: 'wind',          nameAr: 'مكونات طاقة الرياح',      nameEn: 'Wind Energy',       icon: '🌬️', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'capacity_kw', labelAr: 'القدرة (kW)', type: 'number', required: true, unit: 'kW' }, { key: 'rotor_diameter_m', labelAr: 'قطر الدوار (م)', type: 'number', required: false, unit: 'm' }] },
  { sectorCode: 'desalination',  nameAr: 'محطات التحلية',           nameEn: 'Desalination',      icon: '💧', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'membrane_type', labelAr: 'نوع الغشاء', type: 'select', required: true, options: ['RO', 'NF', 'UF', 'MF'] }, { key: 'flow_rate_m3h', labelAr: 'معدل التدفق (m³/h)', type: 'number', required: true }] },
  { sectorCode: 'infant_formula', nameAr: 'ألبان الأطفال',           nameEn: 'Infant Formula',    icon: '🍼', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'age_group', labelAr: 'الفئة العمرية', type: 'select', required: true, options: ['Stage 1 (0-6M)', 'Stage 2 (6-12M)', 'Stage 3 (1-3Y)'] }, { key: 'halal_cert', labelAr: 'شهادة حلال', type: 'boolean', required: true }] },
  { sectorCode: 'polyester',     nameAr: 'صناعة البوليستر',          nameEn: 'Polyester',         icon: '🧶', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'denier', labelAr: 'دنير', type: 'number', required: true, unit: 'D' }, { key: 'recycled', labelAr: 'معاد تدويره', type: 'boolean', required: false }] },
  { sectorCode: 'soda_ash',      nameAr: 'الصودا آش',                nameEn: 'Soda Ash',          icon: '🧪', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'purity_pct', labelAr: 'درجة النقاوة ٪', type: 'number', required: true, unit: '%' }, { key: 'food_grade', labelAr: 'درجة غذائية', type: 'boolean', required: false }] },
  { sectorCode: 'electric_motors', nameAr: 'المحركات الكهربائية',   nameEn: 'Electric Motors',   icon: '⚙️', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'power_kw', labelAr: 'القدرة (kW)', type: 'number', required: true, unit: 'kW' }, { key: 'speed_rpm', labelAr: 'السرعة (RPM)', type: 'number', required: true, unit: 'RPM' }] },
  { sectorCode: 'inks',          nameAr: 'الأحبار الصناعية',         nameEn: 'Industrial Inks',   icon: '🖨️', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'viscosity_cps', labelAr: 'اللزوجة (cPs)', type: 'number', required: true, unit: 'cPs' }, { key: 'substrate', labelAr: 'الوسيط', type: 'select', required: true, options: ['ورق', 'بلاستيك', 'معدن', 'زجاج'] }] },
  { sectorCode: 'electrical_tools', nameAr: 'الأدوات الكهربائية',   nameEn: 'Electrical Tools',  icon: '🔌', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'ampere_rating', labelAr: 'الأمبير', type: 'number', required: true, unit: 'A' }, { key: 'breaking_capacity', labelAr: 'قدرة القطع (kA)', type: 'number', required: false }] },
  { sectorCode: 'recyclables',   nameAr: 'مواد قابلة للتدوير',       nameEn: 'Recyclables',       icon: '♻️', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'material_type', labelAr: 'نوع المادة', type: 'select', required: true, options: ['بلاستيك', 'ورق', 'زجاج', 'معادن', 'نفايات إلكترونية'] }, { key: 'purity_pct', labelAr: 'درجة النقاوة ٪', type: 'number', required: true }] },
  { sectorCode: 'chillers',      nameAr: 'تشيلرز التكييف المركزي',   nameEn: 'Chillers',          icon: '❄️', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'capacity_tr', labelAr: 'السعة (TR)', type: 'number', required: true, unit: 'TR' }, { key: 'cop', labelAr: 'معامل الأداء COP', type: 'number', required: false }, { key: 'refrigerant', labelAr: 'نوع المبرد', type: 'select', required: true, options: ['R134a', 'R410A', 'R32', 'R1234ze', 'R717 (NH₃)'] }] },
  { sectorCode: 'elevators',     nameAr: 'المصاعد والسلالم',          nameEn: 'Elevators',         icon: '🛗', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'capacity_kg', labelAr: 'الحمولة (kg)', type: 'number', required: true, unit: 'kg' }, { key: 'speed_mps', labelAr: 'السرعة (m/s)', type: 'number', required: true, unit: 'm/s' }, { key: 'travel_height_m', labelAr: 'ارتفاع الرحلة (م)', type: 'number', required: true }] },
  { sectorCode: 'surveillance',  nameAr: 'أنظمة المراقبة الذكية',    nameEn: 'Surveillance',      icon: '📹', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'resolution', labelAr: 'الدقة', type: 'select', required: true, options: ['2MP (1080p)', '4MP', '5MP', '8MP (4K)'] }, { key: 'ai_analytics', labelAr: 'تحليل بالذكاء الاصطناعي', type: 'boolean', required: false }, { key: 'storage_tb', labelAr: 'التخزين (TB)', type: 'number', required: false }] },
  { sectorCode: 'robotics',      nameAr: 'الروبوتات المتقدمة',        nameEn: 'Robotics',          icon: '🤖', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'payload_kg', labelAr: 'الحمولة (kg)', type: 'number', required: true, unit: 'kg' }, { key: 'reach_mm', labelAr: 'مدى الوصول (mm)', type: 'number', required: true }, { key: 'repeatability_mm', labelAr: 'دقة التكرار (mm)', type: 'number', required: false }] },
  { sectorCode: 'green_hydrogen', nameAr: 'الهيدروجين الأخضر',       nameEn: 'Green Hydrogen',    icon: '🌿', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'purity_pct', labelAr: 'درجة النقاوة ٪', type: 'number', required: true, unit: '%' }, { key: 'pressure_bar', labelAr: 'ضغط التخزين (bar)', type: 'number', required: true }, { key: 'capacity_kg_day', labelAr: 'الطاقة الإنتاجية (kg/day)', type: 'number', required: false }] },
  { sectorCode: 'leather',       nameAr: 'الصناعات الجلدية',          nameEn: 'Leather',           icon: '👜', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'thickness_mm', labelAr: 'السُّمك (mm)', type: 'number', required: true, unit: 'mm' }, { key: 'tanning_type', labelAr: 'نوع الدباغة', type: 'select', required: true, options: ['Chrome', 'Vegetable', 'Combination', 'Aldehyde'] }, { key: 'finish', labelAr: 'التشطيب', type: 'select', required: false, options: ['Full Grain', 'Top Grain', 'Split', 'Nubuck', 'Suede'] }] },
  { sectorCode: 'seamless_pipes', nameAr: 'مواسير غير ملحومة',        nameEn: 'Seamless Pipes',    icon: '🔩', generalFields: GENERAL_FIELDS, specificFields: [{ key: 'od_mm', labelAr: 'القطر الخارجي (mm)', type: 'number', required: true, unit: 'mm' }, { key: 'wall_thickness', labelAr: 'سُمك الجدار (mm)', type: 'number', required: true, unit: 'mm' }, { key: 'pressure_rating', labelAr: 'تقدير الضغط', type: 'text', required: false }, { key: 'api_standard', labelAr: 'معيار API', type: 'select', required: false, options: ['API 5L', 'API 5CT', 'ASTM A106', 'ASTM A53'] }] },
];

// Helper to get template by sector code
export function getTemplate(sectorCode: string): SectorTemplate | undefined {
  return SECTOR_TEMPLATES.find(t => t.sectorCode === sectorCode);
}

// Export for seed
export const SECTOR_CODES = SECTOR_TEMPLATES.map(t => t.sectorCode);
