# frozen_string_literal: true

# Run in SketchUp Ruby Console:
# load '/absolute/path/to/MZ20K_Hardcut_Setup.rb'

module CodexMZ20KHardcut
  extend self

  W = 14.40
  H = 13.40
  SEAM = 6.62
  THROW = 20.00
  LENS_Z = 3.00
  FOOTPRINT_W = H * 1200.0 / 1920.0
  LEFT_X = SEAM / 2.0
  RIGHT_X = SEAM + (W - SEAM) / 2.0

  def mm(value)
    value.to_f.m
  end

  def material(model, name, rgb, alpha = 1.0)
    mat = model.materials[name] || model.materials.add(name)
    mat.color = Sketchup::Color.new(*rgb)
    mat.alpha = alpha
    mat
  end

  def tag(model, name)
    model.layers[name] || model.layers.add(name)
  end

  def paint(group, mat)
    group.entities.grep(Sketchup::Face).each do |face|
      face.material = mat
      face.back_material = mat
    end
  end

  def box(parent, name, x0, y0, z0, x1, y1, z1, mat, layer)
    group = parent.add_group
    group.name = name
    group.layer = layer
    pts = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0]].map { |p| Geom::Point3d.new(*p.map { |v| mm(v) }) }
    face = group.entities.add_face(pts)
    face.reverse! if face.normal.z < 0
    face.pushpull(mm(z1 - z0))
    paint(group, mat)
    group
  end

  def wall_patch(parent, name, x0, x1, y, mat, layer)
    group = parent.add_group
    group.name = name
    group.layer = layer
    pts = [[x0,y,0],[x1,y,0],[x1,y,H],[x0,y,H]].map { |p| Geom::Point3d.new(*p.map { |v| mm(v) }) }
    face = group.entities.add_face(pts)
    face.material = mat
    face.back_material = mat
    group
  end

  def beam(parent, name, x, mat, layer)
    group = parent.add_group
    group.name = name
    group.layer = layer
    apex = Geom::Point3d.new(mm(x), mm(-THROW), mm(LENS_Z))
    half = FOOTPRINT_W / 2.0
    corners = [[x-half,0,0],[x+half,0,0],[x+half,0,H],[x-half,0,H]].map { |p| Geom::Point3d.new(*p.map { |v| mm(v) }) }
    4.times do |i|
      face = group.entities.add_face(apex, corners[i], corners[(i + 1) % 4])
      face.material = mat
      face.back_material = mat
    end
    face = group.entities.add_face(corners)
    face.material = mat
    face.back_material = mat
    group
  end

  def projector(parent, name, x, beam_mat, mats, tags)
    box(parent, "#{name}_Tower", x-0.55, -THROW-0.55, 0, x+0.55, -THROW+0.55, LENS_Z-0.34, mats[:tower], tags[:rig])
    # Portrait orientation. Approximate MZ20K body: 440 W x 650 H x 211 D mm.
    box(parent, "#{name}_PT-MZ20K_PORTRAIT", x-0.22, -THROW-0.325, LENS_Z-0.325, x+0.22, -THROW+0.325, LENS_Z-0.114, mats[:projector], tags[:projectors])
    beam(parent, "#{name}_FULL_OPTICAL_BEAM", x, beam_mat, tags[:beams])
    parent.add_text("#{name}\nPT-MZ20K + ET-EMS650\nPortrait / Lens CL +#{format('%.2f', LENS_Z)} m", Geom::Point3d.new(mm(x+0.7), mm(-THROW), mm(LENS_Z+0.2)))
  end

  def create
    model = Sketchup.active_model
    model.start_operation('MZ20K Hardcut Setup', true)

    root = model.entities.add_group
    root.name = 'MZ20K_HARDCUT_LAYOUT_CONCEPT'
    e = root.entities

    tags = {
      ground: tag(model, '00_GROUND'),
      facade: tag(model, '01_FACADE_APPROX'),
      active: tag(model, '02_ACTIVE_IMAGE_HARDCUT'),
      beams: tag(model, '03_FULL_OPTICAL_BEAMS'),
      projectors: tag(model, '04_MZ20K_PROJECTORS'),
      rig: tag(model, '05_RIG_TOWERS'),
      notes: tag(model, '06_NOTES_DIMS')
    }
    mats = {
      ground: material(model, 'Ground', [48, 52, 58]),
      facade: material(model, 'Facade Beige', [186, 163, 127]),
      groove: material(model, 'Wall Grooves', [58, 41, 30]),
      projector: material(model, 'MZ20K Body', [23, 26, 31]),
      tower: material(model, 'Rig Tower', [100, 108, 116]),
      left_beam: material(model, 'PJ-L Optical Beam', [30, 139, 255], 0.22),
      right_beam: material(model, 'PJ-R Optical Beam', [255, 82, 45], 0.22),
      left_active: material(model, 'PJ-L Active Hardcut', [30, 139, 255], 0.55),
      right_active: material(model, 'PJ-R Active Hardcut', [255, 82, 45], 0.55),
      cut: material(model, 'Hardcut Seam', [255, 232, 60])
    }

    box(e, 'Ground', -2, -22, -0.12, W+2, 2, 0, mats[:ground], tags[:ground])

    bays = [0, 2.62, 4.62, 6.62, 8.32, 11.17, 13.12, 14.40]
    depths = [0.28, 0.52, 0.34, 0.58, 0.30, 0.50, 0.26]
    bays.each_cons(2).with_index do |(a, b), i|
      box(e, "Facade Bay #{i+1}", a, -depths[i], 0, b, 0, H, mats[:facade], tags[:facade])
      box(e, "Wall Groove #{i}", a-0.035, -0.62, 0, a+0.035, -0.01, H, mats[:groove], tags[:facade]) if i.positive?
    end

    wall_patch(e, 'PJ-L ACTIVE — HARD EDGE', 0, SEAM, -0.64, mats[:left_active], tags[:active])
    wall_patch(e, 'PJ-R ACTIVE — HARD EDGE', SEAM, W, -0.65, mats[:right_active], tags[:active])
    box(e, 'HARD CUT @ GRID 16', SEAM-0.045, -0.72, 0, SEAM+0.045, -0.66, H, mats[:cut], tags[:active])

    projector(e, 'PJ-L', LEFT_X, mats[:left_beam], mats, tags)
    projector(e, 'PJ-R', RIGHT_X, mats[:right_beam], mats, tags)

    notes = e.add_group
    notes.name = 'NOTES AND DIMENSIONS'
    notes.layer = tags[:notes]
    ne = notes.entities
    ne.add_text('HARD CUT @ architectural groove Grid 16 / x=6.62 m\nNO EDGE BLENDING — trace the surveyed groove in the final warp mask', Geom::Point3d.new(mm(SEAM+0.25), mm(-0.9), mm(H+0.45)))
    ne.add_text("Facade envelope #{format('%.2f', W)} × #{format('%.2f', H)} m", Geom::Point3d.new(mm(0), mm(-0.9), mm(H+1.0)))
    ne.add_text("Throw #{format('%.2f', THROW)} m / TR #{format('%.2f', THROW/H)}:1 / Portrait optical footprint #{format('%.3f', FOOTPRINT_W)} × #{format('%.2f', H)} m", Geom::Point3d.new(mm(0), mm(-THROW+1.0), mm(0.4)))
    ne.add_dimension_linear(Geom::Point3d.new(0,0,0), Geom::Point3d.new(mm(W),0,0), Geom::Vector3d.new(0,0,mm(-0.8)))
    ne.add_dimension_linear(Geom::Point3d.new(0,0,0), Geom::Point3d.new(0,0,mm(H)), Geom::Vector3d.new(mm(-0.8),0,0))
    ne.add_dimension_linear(Geom::Point3d.new(mm(-1.2),0,0), Geom::Point3d.new(mm(-1.2),mm(-THROW),0), Geom::Vector3d.new(mm(-0.6),0,0))

    model.commit_operation

    # Save useful scenes. These are concept views; users can update styles after generation.
    view = model.active_view
    view.camera = Sketchup::Camera.new(Geom::Point3d.new(mm(24),mm(-29),mm(21)), Geom::Point3d.new(mm(W/2),mm(-7),mm(H/2)), Z_AXIS, true)
    model.pages.add('01_Perspective_Beams')
    view.camera = Sketchup::Camera.new(Geom::Point3d.new(mm(W/2),mm(-35),mm(H/2)), Geom::Point3d.new(mm(W/2),0,mm(H/2)), Z_AXIS, false)
    model.pages.add('02_Front_Hardcut')
    view.camera = Sketchup::Camera.new(Geom::Point3d.new(mm(W/2),mm(-9),mm(32)), Geom::Point3d.new(mm(W/2),mm(-9),0), Geom::Vector3d.new(0,1,0), false)
    model.pages.add('03_Top_Beam_Plan')
    view.zoom_extents

    UI.messagebox("MZ20K Hardcut concept created.\n2 × PT-MZ20K Portrait / ET-EMS650 / Throw 20 m / Hard Cut Grid 16.")
  rescue StandardError => e
    model.abort_operation if model
    UI.messagebox("MZ20K layout error: #{e.message}\n#{e.backtrace.first(5).join("\n")}")
    raise
  end

  create
end

